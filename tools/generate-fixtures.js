import { ensureFixtures } from "./fixtures.js";

const fixtures = await ensureFixtures();
console.log(`init: ${fixtures.init}`);
for (const segment of fixtures.segments) console.log(`segment: ${segment}`);
