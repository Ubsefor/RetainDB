#!/usr/bin/env node
import { capture, printContextPack, readHookInput } from "./_capture.mjs";
const { data } = await readHookInput();
await printContextPack(data, "pre_compact", data.prompt || data.message || "compact session delta context");
await capture("pre_compact", data);
