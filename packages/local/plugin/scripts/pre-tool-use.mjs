#!/usr/bin/env node
import { capture, printContextPack, readHookInput } from "./_capture.mjs";
const { data } = await readHookInput();
await printContextPack(data, "pre_tool_use", data.tool_input || data.tool_name || data.command || "relevant code context before tool use");
await capture("pre_tool_use", data);
