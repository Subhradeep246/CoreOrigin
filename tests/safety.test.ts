import assert from "node:assert/strict";
import test from "node:test";
import { assessEmergency } from "../lib/safety";

test("flags common emergency red flags", () => {
  assert.equal(assessEmergency("My face is drooping and I have sudden slurred speech").category, "stroke");
  assert.equal(assessEmergency("I have severe chest pain").category, "cardiac");
  assert.equal(assessEmergency("I can't breathe and I'm gasping for air").category, "breathing");
  assert.equal(assessEmergency("I want to kill myself").category, "self_harm");
});

test("does not flag routine or explicitly denied symptoms", () => {
  assert.equal(assessEmergency("I need an annual physical").emergency, false);
  assert.equal(assessEmergency("I have no chest pain, only a routine follow-up").emergency, false);
});
