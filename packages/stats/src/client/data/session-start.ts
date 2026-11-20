export function validProjectName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function sessionOpenUrl(link: { url: string; pairUrl?: string }): string {
	return link.pairUrl ?? link.url;
}

export async function createAndStartProject(
	create: () => Promise<{ path: string }>,
	start: (path: string) => Promise<unknown>,
): Promise<string> {
	const { path } = await create();
	await start(path);
	return path;
}
