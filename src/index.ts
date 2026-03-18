import { csvIndexes } from "../data/indexes";

const configuredCups = Object.keys(csvIndexes).length;

console.log(`Cup of the Day project ready. Configured cups: ${configuredCups}`);