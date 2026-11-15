import type { ComponentProps } from 'react';
import { isSameOriginImage } from './lib/image-policy';

type MarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

function pageOrigin(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.origin;
}

/** Streamdown's `img`: an image from another origin renders nothing at all, so it is never fetched. */
function SameOriginImage({ src, alt, title }: MarkdownImageProps) {
  if (!isSameOriginImage(src, pageOrigin())) return null;
  return <img src={src} alt={alt ?? ''} title={title} loading="lazy" />;
}

/** Props for CopilotKit's assistant markdown renderer (Streamdown); stable, so messages don't re-render. */
export const ASSISTANT_MARKDOWN = { components: { img: SameOriginImage } };
