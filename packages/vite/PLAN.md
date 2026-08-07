# @ink/vite plan

Status: implemented.

## Purpose

Provide the opinionated Vite configuration for an Ink development application
without coupling the browser host to a source language. Applications declare the
directories that produce their Wasm artifact and may replace the standard build
command when their toolchain does not use the default `ink.ts` entry.

## Ownership

This package owns the React, React Compiler, Tailwind, Vite, hot-reload, asset
synchronization, and production-build defaults. `@ink/development` retains the
lower-level host and Vite plugin. Applications retain their game sources,
assets, artifact builder, renderer choices, and specialized editor composition.

## Artifact contract

The build command must publish a Wasm module and the manifest required by the
application's Ink guest loader. Blot is one supported producer of those files;
Rust, C, and other Wasm toolchains can use the same configuration.

## Acceptance

- One `define_ink_game` call replaces the repeated Vite plugin configuration.
- The package supplies the default HTML shell and browser mount entry.
- A language adapter supplies artifact identity and browser loading behavior.
- Relative source and resource directories resolve from the application.
- The default command runs the application's `ink.ts` through Deno.
- Custom build commands and non-Blot source directories remain supported.
- Invalid non-file directory references fail with the offending field and URL.
