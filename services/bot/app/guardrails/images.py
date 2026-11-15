"""Images in model text: the bot never sends one, and a remote image loads with no click, so its URL could carry
conversation data off-site. Markdown images become their alt text and HTML images are dropped."""

import re

MARKDOWN_IMAGE = re.compile(r"!\[([^\]\n]*)\]\([^)\n]*\)")
# A sentence break inside an image's alt text splits it across checks, so a lone opener is defused too: without
# the "!" what is left is at most a link, which needs a click.
IMAGE_OPENER = re.compile(r"!\[")
HTML_IMAGE = re.compile(r"<img\b[^>]*>?", re.IGNORECASE)


def strip_images(text: str) -> str:
    text = MARKDOWN_IMAGE.sub(lambda match: match.group(1), text)
    text = IMAGE_OPENER.sub("[", text)
    return HTML_IMAGE.sub("", text)
