import * as fs from "node:fs/promises";

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });

// Bundle the React app. CSS imported from TSX modules is emitted alongside as index.css.
console.log("Building dashboard client...");
const result = await Bun.build({
	entrypoints: ["./src/client/index.tsx"],
	outdir: "./dist/client",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}
// A separate same-origin worker keeps parsing untrusted plans off the UI thread.
const worker = await Bun.build({
	entrypoints: ["./src/client/routes/plan-markdown-worker.ts"],
	outdir: "./dist/client",
	conditions: ["worker"],
	minify: true,
	naming: "plan-markdown-worker.js",
});
if (!worker.success) {
	for (const message of worker.logs) console.error(message);
	process.exit(1);
}

// theme.js applies the persisted theme before first paint (no flash). It is a file, not an inline
// script, so the page works under a strict Content-Security-Policy (script-src 'self').
const themeJs = `(function () {
  try {
    var stored = localStorage.getItem("omp-stats-theme");
    var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var theme = stored === "light" || stored === "dark" ? stored : system;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (e) {}
})();
`;

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="omp">
    <title>omp</title>
    <script src="theme.js"></script>
    <link rel="stylesheet" href="index.css">
    <link rel="icon" type="image/x-icon" href="favicon.ico">
    <link rel="manifest" href="manifest.webmanifest">
    <link rel="apple-touch-icon" href="apple-touch-icon.png">
    <meta name="theme-color" content="#0E1016">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

// Static asset the bundler never emits; copied beside index.css so the on-disk client and the embedded archive both serve it.
await fs.copyFile("./src/client/favicon.ico", "./dist/client/favicon.ico");

// Installable-app files: the manifest and its icons (PNG, since iOS ignores SVG home-screen icons).
for (const file of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
	await fs.copyFile(`./src/client/icons/${file}`, `./dist/client/${file}`);
}

// build.json tells the hub which UI build it serves (shown by /api/hub/version). The id is a hash of the
// bundle, so it changes exactly when the shipped code does.
const hasher = new Bun.CryptoHasher("sha256");
for (const file of ["index.js", "index.css", "plan-markdown-worker.js"])
	hasher.update(await Bun.file(`./dist/client/${file}`).bytes());
await Bun.write(
	"./dist/client/build.json",
	JSON.stringify({ buildId: hasher.digest("hex").slice(0, 12), builtAt: new Date().toISOString() }),
);

await Bun.write("./dist/client/theme.js", themeJs);
await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
