import * as esbuild from "esbuild";

const options = {
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
    options: "src/options.js",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "extension",
  minify: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
