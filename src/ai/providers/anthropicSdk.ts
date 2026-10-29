// The Anthropic SDK as a bundle of its own (out/anthropic.js, package.json bundle:anthropic): the
// adapter (anthropic.ts) requires it the first time Anthropic is used. Inside extension.js its
// ~400 KB were parsed at every activation, before the Log's first rows, Anthropic or not.
export * from "@anthropic-ai/sdk";
export { default } from "@anthropic-ai/sdk";
