# Repository Guidelines

## Project Structure & Module Organization
This repository is a small TypeScript CLI-style app. Source files live under `src/`, with `src/main.ts` as the current entry point. The `src/channels`, `src/core`, `src/services`, and `src/utils` directories are reserved for feature modules as the codebase grows. Compiled output is written to `dist/`. Keep runtime code in `src/` and avoid editing generated files in `dist/`.

## Build, Test, and Development Commands
Use `pnpm` for all package management.

- `pnpm dev`: run `src/main.ts` with `tsx` in watch mode for local development.
- `pnpm build`: compile TypeScript to `dist/` with `tsc`.
- `pnpm start`: run the compiled app from `dist/main.js`.
- `pnpm check`: run TypeScript type-checking without emitting files.

Run `pnpm check && pnpm build` before opening a PR.

## Coding Style & Naming Conventions
Use TypeScript with `strict` mode enabled. Prefer small modules, explicit types at public boundaries, and imports through the `@/*` path alias when it improves clarity. Follow the existing code style: 2-space indentation, double-quoted strings, and semicolons. Name files in lowercase when they map to runtime modules (for example, `src/services/logger.ts`). Use `PascalCase` for types/classes, `camelCase` for functions and variables, and clear verb-based names for commands.

## Testing Guidelines
There is no test framework configured yet. Until one is added, treat `pnpm check` as the minimum validation step and manually exercise changes with `pnpm dev` or `pnpm start`. When tests are introduced, place them beside the code they cover or under a dedicated `src/**/__tests__` layout, and use `*.test.ts` naming.

## Commit & Pull Request Guidelines
Git history currently follows Conventional Commits (`feat: Project init`). Continue using that format, for example `fix: handle startup errors` or `chore: tighten tsconfig`. Keep commits focused and reviewable. PRs should include a short summary, linked issue when applicable, and the exact validation performed. For user-visible CLI changes, include sample output or invocation notes.
