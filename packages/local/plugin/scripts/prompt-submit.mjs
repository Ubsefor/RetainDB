#!/usr/bin/env node
import { capture, printContextPack, readHookInput } from "./_capture.mjs";
const { data } = await readHookInput();
await printContextPack(data, "prompt_submit", data.prompt || data.message || "user task context");
await capture("prompt_submit", data);
