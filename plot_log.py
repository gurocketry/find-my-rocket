#!/usr/bin/env python3
"""Create a readable telemetry summary from the tracker's log.csv file."""

from __future__ import annotations

import argparse
import csv
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median


STAGE_NAMES = {
    0: "Pad",
    1: "Burning",
    2: "Coasting",
    3: "Descent",
    4: "Landed",
    255: "Unknown",
}

STAGE_COLOURS = {
    0: "#d1d5db",
    1: "#ffd42a",
    2: "#9ca3af",
    3: "#ffe784",
    4: "#6b7280",
    255: "#4b5563",
}


@dataclass(frozen=True)
class TelemetryPoint:
    stage: int
    flags: str
    latitude: float
    longitude: float
    altitude: float
    rssi: int
    satellites: int


@dataclass(frozen=True)
class EnvironmentPoint:
    timestamp: float
    temperature: float
    pressure: float
    humidity: float
    gas_resistance: float
    methane: float


@dataclass(frozen=True)
class AstraPoint:
    time: float
    stage: int
    gps_altitude: float | None
    barometric_altitude: float | None
    kalman_altitude: float | None
    kalman_velocity: float | None
    acceleration: float | None


def optional_float(row: dict[str, str], field: str, low: float, high: float) -> float | None:
    """Parse a sparse Astra value, rejecting sentinels and impossible values."""
    try:
        value = float(row.get(field, ""))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and low <= value <= high else None


def read_astra_log(path: Path) -> tuple[list[AstraPoint], int]:
    """Read the flight board's sparse event log and normalize its microsecond clock."""
    raw_points: list[
        tuple[float, int, float | None, float | None, float | None, float | None, float | None]
    ] = []
    skipped = 0
    required = {"timestamp", "state", "gps_alt", "baro_alt", "kalman_alt"}
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            missing = ", ".join(sorted(required.difference(reader.fieldnames or [])))
            raise ValueError(f"Astra CSV is missing fields: {missing}")
        for row in reader:
            try:
                timestamp = float(row["timestamp"])
                stage = int(row["state"])
            except (TypeError, ValueError):
                skipped += 1
                continue
            # Zero-timestamp rows are redundant snapshots emitted between real events.
            if timestamp <= 0:
                continue
            gps_altitude = optional_float(row, "gps_alt", -1000, 10_000)
            latitude = optional_float(row, "gps_lat", -90, 90)
            longitude = optional_float(row, "gps_lon", -180, 180)
            if latitude in (None, 0.0) and longitude in (None, 0.0):
                gps_altitude = None
            acceleration_components = (
                    optional_float(row, "accX", -250, 250),
                    optional_float(row, "accY", -250, 250),
                    optional_float(row, "accZ", -250, 250),
            )
            acceleration = (
                math.sqrt(sum(value * value for value in acceleration_components))
                if all(value is not None for value in acceleration_components)
                else None
            )
            raw_points.append((
                timestamp,
                stage,
                gps_altitude,
                optional_float(row, "baro_alt", 50, 10_000),
                optional_float(row, "kalman_alt", -100, 10_000),
                optional_float(row, "kalman_vel", -1_000, 1_000),
                acceleration,
            ))
    if not raw_points:
        raise ValueError(f"No valid Astra records found in {path}")

    start = raw_points[0][0]
    points = [
        AstraPoint(
            (timestamp - start) / 1_000_000, stage, gps, baro,
            kalman, velocity, acceleration,
        )
        for timestamp, stage, gps, baro, kalman, velocity, acceleration in raw_points
        if timestamp >= start
    ]
    return points, skipped


def read_log(path: Path) -> tuple[list[TelemetryPoint], int]:
    """Read the receiver's headerless CSV, returning points and skipped row count."""
    points: list[TelemetryPoint] = []
    skipped = 0

    with path.open(newline="", encoding="utf-8") as source:
        for row_number, row in enumerate(csv.reader(source), 1):
            if not row or all(not value.strip() for value in row):
                continue
            try:
                if len(row) != 6:
                    raise ValueError("expected six comma-separated fields")
                stage_text, flags = row[0].split(maxsplit=1)
                point = TelemetryPoint(
                    stage=int(stage_text),
                    flags=flags,
                    latitude=float(row[1]),
                    longitude=float(row[2]),
                    altitude=float(row[3]),
                    rssi=int(row[4]),
                    satellites=int(row[5]),
                )
                points.append(point)
            except (ValueError, IndexError):
                skipped += 1
                print(f"Warning: skipping malformed row {row_number}: {row}")

    if not points:
        raise ValueError(f"No valid telemetry rows found in {path}")
    return points, skipped


def read_environment_log(path: Path) -> tuple[list[EnvironmentPoint], int]:
    """Read the environmental board's named CSV fields."""
    points: list[EnvironmentPoint] = []
    skipped = 0
    required = {
        "timestamp", "temperature", "pressure", "humidity",
        "gasResistance", "methane",
    }
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            missing = ", ".join(sorted(required.difference(reader.fieldnames or [])))
            raise ValueError(f"Environmental CSV is missing fields: {missing}")
        for row_number, row in enumerate(reader, 2):
            try:
                if "sensorUpdateStatus" in row and int(row["sensorUpdateStatus"]) != 1:
                    raise ValueError("sensor update was not valid")
                points.append(EnvironmentPoint(
                    timestamp=float(row["timestamp"]),
                    temperature=float(row["temperature"]),
                    pressure=float(row["pressure"]),
                    humidity=float(row["humidity"]),
                    gas_resistance=float(row["gasResistance"]),
                    methane=float(row["methane"]),
                ))
            except (TypeError, ValueError):
                skipped += 1
                print(f"Warning: skipping malformed environmental row {row_number}")
    if not points:
        raise ValueError(f"No valid environmental rows found in {path}")
    return points, skipped


def timestamp_divisor(points: list[EnvironmentPoint]) -> tuple[float, str]:
    """Infer whether an embedded timestamp is seconds, milliseconds, or microseconds."""
    if len(points) < 2:
        return 1.0, "seconds"
    differences = [
        later.timestamp - earlier.timestamp
        for earlier, later in zip(points, points[1:])
        if later.timestamp > earlier.timestamp
    ]
    typical = median(differences) if differences else 1.0
    if typical > 10_000:
        return 1_000_000.0, "microseconds"
    if typical > 10:
        return 1_000.0, "milliseconds"
    return 1.0, "seconds"


def stage_spans(points: list[AstraPoint]):
    """Yield contiguous onboard flight-state regions in seconds."""
    start = points[0].time
    current = points[0].stage
    for point in points[1:]:
        if point.stage != current:
            yield start, point.time, current
            start, current = point.time, point.stage
    yield start, points[-1].time, current


def interpolate_values(
    samples: list[tuple[float, float]], query_times: list[float]
) -> list[float | None]:
    """Linearly interpolate a chronological series at chronological query times."""
    if not samples:
        return [None] * len(query_times)
    result: list[float | None] = []
    cursor = 0
    for query in query_times:
        while cursor + 1 < len(samples) and samples[cursor + 1][0] < query:
            cursor += 1
        if query < samples[0][0] or query > samples[-1][0] or cursor + 1 >= len(samples):
            result.append(None)
            continue
        left_time, left_value = samples[cursor]
        right_time, right_value = samples[cursor + 1]
        if right_time == left_time:
            result.append(right_value)
        else:
            fraction = (query - left_time) / (right_time - left_time)
            result.append(left_value + fraction * (right_value - left_value))
    return result


def save_plot_pages(
    points: list[AstraPoint],
    environment: list[EnvironmentPoint] | None,
    environment_times: list[float],
    kalman: list[tuple[float, float]],
    barometric: list[tuple[float, float]],
    gps: list[tuple[float, float]],
    output_dir: Path,
) -> None:
    """Export each chart as a separate 16:9 PNG suitable for slides."""
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    output_dir.mkdir(parents=True, exist_ok=True)
    stage_regions = list(stage_spans(points))
    stages_seen = list(dict.fromkeys(stage for _, _, stage in stage_regions))
    stage_handles = [
        Line2D([0], [0], marker="s", linestyle="", markersize=8,
               markerfacecolor=STAGE_COLOURS.get(stage, STAGE_COLOURS[255]),
               markeredgewidth=0, label=STAGE_NAMES.get(stage, f"Stage {stage}"))
        for stage in stages_seen
    ]

    def new_page(title: str, time_based: bool = True):
        page, axis = plt.subplots(figsize=(13.333, 7.5), layout="constrained", facecolor="#ffffff")
        axis.set_facecolor("#ffffff")
        axis.set_title(title, fontsize=19, fontweight="bold", pad=14)
        axis.grid(True, color="#9ca3af", alpha=0.45, linewidth=0.8)
        for spine in axis.spines.values():
            spine.set_color("#6b7280")
        if time_based:
            for start, end, stage in stage_regions:
                colour = STAGE_COLOURS.get(stage, STAGE_COLOURS[255])
                axis.axvspan(start, end, color=colour, alpha=0.10, linewidth=0)
                if start > points[0].time:
                    axis.axvline(start, color=colour, alpha=0.45, linewidth=0.9)
            axis.set_xlim(points[0].time, points[-1].time)
            axis.set_xlabel("Time since Astra log start (s)")
            page.legend(
                handles=stage_handles, title="Onboard flight states",
                loc="upper center", bbox_to_anchor=(0.5, 0.93),
                frameon=False, ncol=len(stage_handles), fontsize=9,
            )
        return page, axis

    def save(page, filename: str) -> None:
        page.savefig(output_dir / filename, dpi=180, facecolor="#ffffff")
        plt.close(page)

    page, axis = new_page("Onboard altitude estimates")
    axis.plot(*zip(*barometric), color="#ffd42a", linewidth=1.4, label="Barometric altitude")
    axis.plot(*zip(*kalman), color="#000000", linewidth=2.2, label="Kalman flight altitude")
    if gps:
        axis.scatter(*zip(*gps), color="#6b7280", s=9, alpha=0.5, label="GPS altitude fixes")
    peak_time, peak_altitude = max(kalman, key=lambda item: item[1])
    axis.scatter(peak_time, peak_altitude, color="#ffd42a", edgecolor="#000000", s=65, zorder=5)
    axis.annotate(f"Peak {peak_altitude:,.1f} m", (peak_time, peak_altitude), xytext=(10, -24), textcoords="offset points")
    axis.set_ylabel("Altitude (m)")
    axis.legend(loc="upper right", frameon=False)
    save(page, "01_altitude.png")

    velocity = [(point.time, point.kalman_velocity) for point in points if point.kalman_velocity is not None]
    page, axis = new_page("Onboard vertical velocity")
    axis.plot(*zip(*velocity), color="#000000", linewidth=1.5, label="Kalman velocity")
    axis.axhline(0, color="#6b7280", linestyle="--", linewidth=0.9)
    axis.set_ylabel("Velocity (m/s)")
    axis.legend(loc="upper right", frameon=False)
    save(page, "02_velocity.png")

    acceleration = [(point.time, point.acceleration) for point in points if point.acceleration is not None]
    page, axis = new_page("Onboard accelerometer magnitude")
    axis.plot(*zip(*acceleration), color="#000000", linewidth=1.0, label="Measured magnitude")
    axis.axhline(9.80665, color="#ffd42a", linestyle="--", linewidth=1.3, label="1 g")
    if acceleration:
        values = sorted(value for _, value in acceleration)
        robust_peak = values[min(int(len(values) * 0.995), len(values) - 1)]
        axis.set_ylim(0, max(15, robust_peak * 1.15))
    axis.set_ylabel("Acceleration (m/s²)")
    axis.legend(loc="upper right", frameon=False)
    save(page, "03_acceleration.png")

    if environment:
        page, axis = new_page("Temperature and humidity")
        axis.plot(environment_times, [point.temperature for point in environment], color="#000000", linewidth=1.6)
        axis.set_ylabel("Temperature (°C)")
        secondary = axis.twinx()
        secondary.plot(environment_times, [point.humidity for point in environment], color="#ffd42a", linewidth=1.7)
        secondary.set_ylabel("Humidity (%)")
        axis.legend(handles=[
            Line2D([0], [0], color="#000000", label="Temperature"),
            Line2D([0], [0], color="#ffd42a", label="Humidity"),
        ], loc="upper right", frameon=False)
        save(page, "04_temperature_humidity.png")

        page, axis = new_page("Atmospheric pressure")
        axis.plot(environment_times, [point.pressure / 100 for point in environment], color="#000000", linewidth=1.7)
        axis.set_ylabel("Pressure (hPa)")
        save(page, "05_pressure.png")

        page, axis = new_page("Gas sensors over time")
        axis.plot(environment_times, [point.gas_resistance / 1000 for point in environment], color="#000000", linewidth=1.5)
        axis.set_ylabel("Gas resistance (kΩ)")
        secondary = axis.twinx()
        secondary.plot(environment_times, [point.methane for point in environment], color="#ffd42a", linewidth=1.6)
        secondary.set_ylabel("Methane (raw)")
        axis.legend(handles=[
            Line2D([0], [0], color="#000000", label="Gas resistance"),
            Line2D([0], [0], color="#ffd42a", label="Methane"),
        ], loc="upper right", frameon=False)
        save(page, "06_gas_over_time.png")

        altitudes = interpolate_values(kalman, environment_times)
        altitude_environment = [(altitude, point) for altitude, point in zip(altitudes, environment) if altitude is not None]
        page, axis = new_page("Gas measurements versus altitude", time_based=False)
        axis.plot(
            [altitude for altitude, _ in altitude_environment],
            [point.gas_resistance / 1000 for _, point in altitude_environment],
            color="#000000", linewidth=1.5,
        )
        axis.set(xlabel="Kalman altitude (m)", ylabel="Gas resistance (kΩ)")
        secondary = axis.twinx()
        secondary.plot(
            [altitude for altitude, _ in altitude_environment],
            [point.methane for _, point in altitude_environment],
            color="#ffd42a", linewidth=1.6,
        )
        secondary.set_ylabel("Methane (raw)")
        axis.legend(handles=[
            Line2D([0], [0], color="#000000", label="Gas resistance"),
            Line2D([0], [0], color="#ffd42a", label="Methane"),
        ], loc="upper right", frameon=False)
        save(page, "07_gas_vs_altitude.png")

    print(f"Saved slide-ready graph pages to {output_dir}")


def plot_log(
    points: list[AstraPoint],
    environment: list[EnvironmentPoint] | None,
    source: Path,
    environment_source: Path | None,
    output: Path,
    pages_dir: Path,
    show: bool,
) -> None:
    """Render aligned onboard flight and environmental telemetry."""
    try:
        import matplotlib
        if not show:
            matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Matplotlib is required. Enter `nix develop`, or run "
            "`python3 -m pip install matplotlib`."
        ) from exc

    plt.style.use("default")
    figure = plt.figure(figsize=(16, 18), layout="constrained", facecolor="#ffffff")
    grid = figure.add_gridspec(7, 1, height_ratios=(2.0, 0.8, 0.8, 1.0, 0.8, 1.0, 1.0))
    altitude_ax = figure.add_subplot(grid[0, 0])
    velocity_ax = figure.add_subplot(grid[1, 0], sharex=altitude_ax)
    acceleration_ax = figure.add_subplot(grid[2, 0], sharex=altitude_ax)
    climate_ax = figure.add_subplot(grid[3, 0], sharex=altitude_ax)
    pressure_ax = figure.add_subplot(grid[4, 0], sharex=altitude_ax)
    air_ax = figure.add_subplot(grid[5, 0], sharex=altitude_ax)
    altitude_gas_ax = figure.add_subplot(grid[6, 0])
    time_axes = (altitude_ax, velocity_ax, acceleration_ax, climate_ax, pressure_ax, air_ax)

    stages_seen: list[int] = []
    for start, end, stage in stage_spans(points):
        colour = STAGE_COLOURS.get(stage, STAGE_COLOURS[255])
        for axis in time_axes:
            axis.axvspan(start, end, color=colour, alpha=0.10, linewidth=0)
            if start > points[0].time:
                axis.axvline(start, color=colour, alpha=0.45, linewidth=0.9)
        if stage not in stages_seen:
            stages_seen.append(stage)

    kalman = [(point.time, point.kalman_altitude) for point in points if point.kalman_altitude is not None]
    barometric = [(point.time, point.barometric_altitude) for point in points if point.barometric_altitude is not None]
    gps = [(point.time, point.gps_altitude) for point in points if point.gps_altitude is not None]
    if not kalman:
        raise ValueError("Astra log contains no valid Kalman altitude records")
    altitude_ax.plot(
        [time for time, _ in barometric], [value for _, value in barometric],
        color="#ffd42a", alpha=0.9, linewidth=1.2, label="Barometric altitude",
    )
    altitude_ax.plot(
        [time for time, _ in kalman], [value for _, value in kalman],
        color="#000000", linewidth=2.0, label="Kalman flight altitude",
    )
    if gps:
        altitude_ax.scatter(
            [time for time, _ in gps], [value for _, value in gps],
            color="#6b7280", s=7, alpha=0.45, label="GPS altitude fixes", zorder=4,
        )
    peak_time, peak_altitude = max(kalman, key=lambda item: item[1])
    altitude_ax.scatter(peak_time, peak_altitude, color="#ffd42a", edgecolor="#000000", s=55, zorder=5)
    altitude_ax.annotate(
        f"Kalman peak {peak_altitude:,.1f} m", (peak_time, peak_altitude),
        xytext=(10, -24), textcoords="offset points", color="#000000", fontsize=10,
    )
    altitude_ax.set(title="Onboard altitude estimates", ylabel="Altitude (m)")
    altitude_ax.tick_params(axis="x", labelbottom=False)
    altitude_legend = altitude_ax.legend(
        loc="upper center", bbox_to_anchor=(0.43, 1.0), frameon=False, ncol=3,
    )

    velocity = [(point.time, point.kalman_velocity) for point in points if point.kalman_velocity is not None]
    velocity_ax.plot(
        [time for time, _ in velocity], [value for _, value in velocity],
        color="#000000", linewidth=1.4, label="Onboard Kalman velocity",
    )
    velocity_ax.axhline(0, color="#6b7280", linestyle="--", linewidth=0.9)
    velocity_ax.set(title="Onboard vertical velocity", ylabel="Velocity (m/s)")
    velocity_ax.tick_params(axis="x", labelbottom=False)
    velocity_ax.legend(loc="upper right", frameon=False, fontsize=8)

    acceleration = [(point.time, point.acceleration) for point in points if point.acceleration is not None]
    acceleration_ax.plot(
        [time for time, _ in acceleration], [value for _, value in acceleration],
        color="#000000", linewidth=1.0, label="Measured magnitude",
    )
    acceleration_ax.axhline(9.80665, color="#ffd42a", linestyle="--", linewidth=1.2, label="1 g")
    if acceleration:
        sorted_acceleration = sorted(value for _, value in acceleration)
        robust_peak = sorted_acceleration[min(int(len(sorted_acceleration) * 0.995), len(sorted_acceleration) - 1)]
        acceleration_ax.set_ylim(0, max(15, robust_peak * 1.15))
    acceleration_ax.set(title="Onboard accelerometer magnitude", ylabel="Acceleration (m/s²)")
    acceleration_ax.tick_params(axis="x", labelbottom=False)
    acceleration_ax.legend(loc="upper right", frameon=False, fontsize=8, ncol=2)

    if environment:
        descent_index = next(
            (index for index, point in enumerate(points) if point.stage == 3),
            max(range(len(points)), key=lambda index: points[index].kalman_altitude or -math.inf),
        )
        environment_start = points[descent_index].time
        divisor, timestamp_unit = timestamp_divisor(environment)
        initial_timestamp = environment[0].timestamp
        environment_times = [
            environment_start + (point.timestamp - initial_timestamp) / divisor
            for point in environment
        ]
        altitude_ax.axvline(environment_start, color="#ffd42a", linestyle="--", linewidth=1.2, alpha=0.9)
        altitude_ax.annotate(
            "Environmental log starts", (environment_start, altitude_ax.get_ylim()[0]),
            xytext=(6, 8), textcoords="offset points", rotation=90,
            color="#000000", fontsize=8, va="bottom",
        )

        climate_ax.plot(environment_times, [point.temperature for point in environment], color="#000000", linewidth=1.5)
        climate_ax.set(title="Temperature and humidity", ylabel="Temperature (°C)")
        climate_ax.tick_params(axis="x", labelbottom=False)
        humidity_ax = climate_ax.twinx()
        humidity_ax.plot(environment_times, [point.humidity for point in environment], color="#ffd42a", linewidth=1.6)
        humidity_ax.set_ylabel("Humidity (%)", color="#000000")
        humidity_ax.tick_params(axis="y", colors="#000000")
        climate_ax.legend(handles=[
            Line2D([0], [0], color="#000000", label="Temperature"),
            Line2D([0], [0], color="#ffd42a", label="Humidity"),
        ], loc="best", frameon=False, fontsize=8)

        pressure_ax.plot(environment_times, [point.pressure / 100 for point in environment], color="#000000", linewidth=1.6)
        pressure_ax.set(title="Atmospheric pressure", ylabel="Pressure (hPa)")
        pressure_ax.tick_params(axis="x", labelbottom=False)

        air_ax.plot(environment_times, [point.gas_resistance / 1000 for point in environment], color="#000000", linewidth=1.4)
        air_ax.set(title="Gas sensors", xlabel="Time since Astra log start (s)", ylabel="Gas resistance (kΩ)")
        methane_ax = air_ax.twinx()
        methane_ax.plot(environment_times, [point.methane for point in environment], color="#ffd42a", linewidth=1.5)
        methane_ax.set_ylabel("Methane (raw)", color="#000000")
        methane_ax.tick_params(axis="y", colors="#000000")
        air_ax.legend(handles=[
            Line2D([0], [0], color="#000000", label="Gas resistance"),
            Line2D([0], [0], color="#ffd42a", label="Methane"),
        ], loc="best", frameon=False, fontsize=8)

        environmental_altitudes = interpolate_values(kalman, environment_times)
        altitude_environment = [
            (altitude, point)
            for altitude, point in zip(environmental_altitudes, environment)
            if altitude is not None
        ]
        altitude_gas_ax.plot(
            [altitude for altitude, _ in altitude_environment],
            [point.gas_resistance / 1000 for _, point in altitude_environment],
            color="#000000", linewidth=1.4, label="Gas resistance",
        )
        altitude_gas_ax.set(
            title="Gas measurements versus altitude",
            xlabel="Kalman altitude (m)",
            ylabel="Gas resistance (kΩ)",
        )
        altitude_methane_ax = altitude_gas_ax.twinx()
        altitude_methane_ax.plot(
            [altitude for altitude, _ in altitude_environment],
            [point.methane for _, point in altitude_environment],
            color="#ffd42a", linewidth=1.5, label="Methane",
        )
        altitude_methane_ax.set_ylabel("Methane (raw)", color="#000000")
        altitude_methane_ax.tick_params(axis="y", colors="#000000")
        altitude_gas_ax.legend(handles=[
            Line2D([0], [0], color="#000000", label="Gas resistance"),
            Line2D([0], [0], color="#ffd42a", label="Methane"),
        ], loc="best", frameon=False, fontsize=8)
        print(
            f"Aligned {len(environment)} environmental samples at Astra descent "
            f"(timestamp interpreted as {timestamp_unit})."
        )
    else:
        for axis, title in zip(
            (climate_ax, pressure_ax, air_ax, altitude_gas_ax),
            ("Temperature and humidity", "Atmospheric pressure", "Gas sensors", "Gas measurements versus altitude"),
        ):
            axis.set_title(title)
            axis.text(0.5, 0.5, "No environmental log found", ha="center", va="center", transform=axis.transAxes)
            axis.set_yticks([])
        air_ax.set_xlabel("Time since Astra log start (s)")

    for axis in (*time_axes, altitude_gas_ax):
        axis.set_facecolor("#ffffff")
        axis.grid(True, color="#9ca3af", alpha=0.45, linewidth=0.7)
        for spine in axis.spines.values():
            spine.set_color("#6b7280")

    stage_handles = [
        Line2D([0], [0], marker="s", linestyle="", markersize=8,
               markerfacecolor=STAGE_COLOURS.get(stage, STAGE_COLOURS[255]),
               markeredgewidth=0, label=STAGE_NAMES.get(stage, f"Stage {stage}"))
        for stage in stages_seen
    ]
    altitude_ax.add_artist(altitude_legend)
    altitude_ax.legend(
        handles=stage_handles, title="Onboard flight states", loc="upper right",
        frameon=False, ncol=min(5, len(stage_handles)), fontsize=8,
    )

    title_sources = source.name
    if environment_source:
        title_sources += f" + {environment_source.name}"
    figure.suptitle(f"Astra Flight & Environment Summary — {title_sources}", fontsize=18, fontweight="bold", color="#000000")
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=180, facecolor=figure.get_facecolor())
    print(f"Saved telemetry graph to {output}")
    save_plot_pages(
        points, environment,
        environment_times if environment else [],
        kalman, barometric, gps, pages_dir,
    )
    if show:
        plt.show()
    plt.close(figure)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input", nargs="?", type=Path, default=Path("astra_real_log.csv"),
        help="Astra onboard event log (default: astra_real_log.csv)",
    )
    parser.add_argument(
        "--environment", type=Path,
        help="environmental CSV (auto-detects status.csv or solara.csv by default)",
    )
    parser.add_argument("-o", "--output", type=Path, default=Path("log_plot.png"), help="output image (default: log_plot.png)")
    parser.add_argument(
        "--pages-dir", type=Path, default=Path("log_plot_pages"),
        help="directory for separate 16:9 graph pages (default: log_plot_pages)",
    )
    parser.add_argument("--show", action="store_true", help="also open an interactive plot window")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        points, skipped = read_astra_log(args.input)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Could not read Astra telemetry: {exc}") from exc
    if skipped:
        print(f"Skipped {skipped} malformed row(s).")

    environment_path = args.environment
    if environment_path is None:
        environment_path = next(
            (path for path in (Path("status.csv"), Path("solara.csv")) if path.is_file()),
            None,
        )
    environment = None
    if environment_path is not None:
        try:
            environment, environment_skipped = read_environment_log(environment_path)
        except (OSError, ValueError) as exc:
            raise SystemExit(f"Could not read environmental telemetry: {exc}") from exc
        if environment_skipped:
            print(f"Skipped {environment_skipped} malformed environmental row(s).")
    plot_log(
        points, environment, args.input, environment_path,
        args.output, args.pages_dir, args.show,
    )


if __name__ == "__main__":
    main()
