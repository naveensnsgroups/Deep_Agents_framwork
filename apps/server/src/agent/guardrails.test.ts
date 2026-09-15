import { describe, expect, it } from "vitest";
import { isOffTopic } from "./guardrails.js";

/**
 * The expensive failure for this guardrail is not letting an off-topic question through —
 * the system prompt catches those. It is blocking real work. So the "allowed" cases below
 * are the ones that matter, and several of them are deliberately worded to look off-topic.
 */
describe("scope guardrail", () => {
  it("declines requests with no software content", () => {
    for (const text of [
      "give me a recipe for butter chicken",
      "write me a poem about the sea",
      "what are the symptoms of the flu?",
      "should I invest in bitcoin right now",
      "what's my horoscope for today",
      "write an essay about the French Revolution",
      "who won the world cup",
    ]) {
      expect(isOffTopic(text), text).toBe(true);
    }
  });

  it("allows software work whose vocabulary looks off-topic", () => {
    for (const text of [
      // Domain words inside genuine migration requests — the false positives that would
      // make the guardrail worse than not having one.
      "migrate the patient-records API to FastAPI",
      "convert the recipe service's Mongoose models to Pydantic",
      "the invest-portfolio module fails to compile, can you debug it",
      "write a poem generator in Python",
      "translate this text parser from Java to Go",
      "our medication-dosage endpoint returns a 500, here's the traceback",
      "write pytest coverage for the horoscope controller",
    ]) {
      expect(isOffTopic(text), text).toBe(false);
    }
  });

  it("allows ordinary development requests", () => {
    for (const text of [
      "migrate this express app to fastapi",
      "why is this test failing?",
      "read src/index.ts and explain it",
      "run the build",
      "what does this function do",
      "```js\nconst x = 1\n```",
    ]) {
      expect(isOffTopic(text), text).toBe(false);
    }
  });

  it("does not block empty or conversational follow-ups", () => {
    // A bare "why?" carries no software signal, but it continues an on-topic thread —
    // blocking it would break normal conversation.
    for (const text of ["", "   ", "why?", "yes", "go ahead", "thanks"]) {
      expect(isOffTopic(text), JSON.stringify(text)).toBe(false);
    }
  });
});
