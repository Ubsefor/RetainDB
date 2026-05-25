#!/usr/bin/env node
import { capture, readHookInput } from "./_capture.mjs";
const { data } = await readHookInput();
await capture("post_tool_use", data);
