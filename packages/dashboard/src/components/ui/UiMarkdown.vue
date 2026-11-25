<script setup lang="ts">
// Renders already-sanitized HTML (lib/markdown → DOMPurify) with compact
// document styles built from the design tokens, so both themes just work.
defineProps<{ html: string }>();
</script>

<template>
	<div class="ui-markdown text-body-s text-fg" v-html="html" />
</template>

<style scoped>
/* v-html content does not get the scoped attribute, hence :deep(). Sizes are
   modest on purpose: this is a message inside a card, not a document. */
.ui-markdown :deep(p),
.ui-markdown :deep(ul),
.ui-markdown :deep(ol),
.ui-markdown :deep(blockquote),
.ui-markdown :deep(table),
.ui-markdown :deep(pre) {
	margin: 0.5rem 0;
}
.ui-markdown :deep(:first-child) {
	margin-top: 0;
}
.ui-markdown :deep(:last-child) {
	margin-bottom: 0;
}
.ui-markdown :deep(h1),
.ui-markdown :deep(h2),
.ui-markdown :deep(h3),
.ui-markdown :deep(h4),
.ui-markdown :deep(h5),
.ui-markdown :deep(h6) {
	font-size: 0.95rem;
	font-weight: 600;
	margin: 0.75rem 0 0.35rem;
}
.ui-markdown :deep(ul) {
	list-style: disc;
	padding-left: 1.25rem;
}
.ui-markdown :deep(ol) {
	list-style: decimal;
	padding-left: 1.25rem;
}
.ui-markdown :deep(li) {
	margin: 0.2rem 0;
}
.ui-markdown :deep(code) {
	font-family: var(--font-mono);
	font-size: 0.8rem;
	background: var(--color-subtle);
	padding: 0.1rem 0.3rem;
	border-radius: 0.25rem;
}
.ui-markdown :deep(pre) {
	background: var(--color-canvas);
	border: 1px solid var(--color-border);
	padding: 0.75rem 1rem;
	border-radius: 0.5rem;
	overflow-x: auto;
}
.ui-markdown :deep(pre code) {
	background: transparent;
	padding: 0;
	font-size: 0.75rem;
}
.ui-markdown :deep(blockquote) {
	border-left: 3px solid var(--color-border-strong);
	padding-left: 0.75rem;
	color: var(--color-fg-muted);
}
.ui-markdown :deep(a) {
	color: var(--color-accent-text);
	text-decoration: underline;
}
.ui-markdown :deep(table) {
	border-collapse: collapse;
}
.ui-markdown :deep(th),
.ui-markdown :deep(td) {
	border: 1px solid var(--color-border);
	padding: 0.25rem 0.5rem;
	text-align: left;
}
.ui-markdown :deep(hr) {
	border-color: var(--color-border);
	margin: 0.75rem 0;
}
</style>
