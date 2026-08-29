import test from "node:test";
import assert from "node:assert/strict";
import { enteredLanded } from "../src/audio.js";

test("plays the landing cue only on transition into landed", () => {
  assert.equal(enteredLanded(3, 4), true);
  assert.equal(enteredLanded(undefined, 4), false);
  assert.equal(enteredLanded(4, 4), false);
  assert.equal(enteredLanded(3, 3), false);
});
