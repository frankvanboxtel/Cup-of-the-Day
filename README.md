# Cup of the Day

Minimal Node.js + TypeScript project for working with the Cup of the Day CSV dataset in this repository.

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Scripts

- `npm run dev` runs the TypeScript entry point directly with `tsx`
- `npm run build` compiles the project to `dist/`
- `npm start` runs the compiled JavaScript output

## Project Structure

```text
data/
  CSV source files
  indexes.ts
src/
  index.ts
dist/
  Compiled JavaScript output after build
```

## Current Behavior

The current entry point in `src/index.ts` imports the cup index mapping from `data/indexes.ts` and prints how many cup configurations are defined.

## Data Notes

- The CSV files are stored in `data/`
- `data/indexes.ts` contains the column index mapping for cup results
- The TypeScript configuration includes both `src/**/*.ts` and `data/**/*.ts`

## Example Workflow

```bash
npm install
npm run dev
npm run build
npm start
```

## Next Steps

Possible extensions for this project:

- parse the CSV files into typed records
- add a small CLI for querying cup results
- add tests for data parsing and index validation
- export normalized JSON from the CSV source data