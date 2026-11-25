// Vite's `?raw` suffix imports a file as a string (used for byte-exact fixtures).
declare module '*?raw' {
	const content: string;
	export default content;
}
