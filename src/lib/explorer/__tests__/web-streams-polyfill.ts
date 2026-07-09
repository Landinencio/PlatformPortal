/**
 * AI Portal Explorer — test-support polyfill for Web Streams globals.
 *
 * Feature: ai-portal-explorer
 *
 * El Triage_Engine importa `@aws-sdk/client-bedrock-runtime`, cuyo middleware
 * de websocket referencia `TransformStream`/`ReadableStream`/`WritableStream`
 * como globales. En Node 16 (runtime de los tests) esos tipos viven en
 * `node:stream/web` pero NO son globales todavía (lo son desde Node 18). Este
 * módulo los expone en `globalThis` para que el `import` del SDK no falle al
 * cargarse en los property-based tests.
 *
 * Debe importarse ANTES que cualquier módulo que cargue el AWS SDK (los imports
 * de ES se evalúan en orden, así que colócalo como primer import del test).
 */

import { TransformStream, ReadableStream, WritableStream } from "node:stream/web";

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.TransformStream === "undefined") g.TransformStream = TransformStream;
if (typeof g.ReadableStream === "undefined") g.ReadableStream = ReadableStream;
if (typeof g.WritableStream === "undefined") g.WritableStream = WritableStream;
