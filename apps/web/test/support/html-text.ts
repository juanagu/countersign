/** The text a user reads from rendered markup: tags dropped, so a split amount reads as one string. */
export function textOf(html: string): string {
  return html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '');
}
