"""Plain-text Activity mentions; recipient access is checked by the caller."""
import re

# Keep email addresses, URLs, code samples and link destinations out of mentions.
_NON_PROSE = re.compile(r"```[\s\S]*?(?:```|$)|`[^`\n]*`|\]\([^\n)]*\)|(?:https?://|mailto:)[^\s<>]+")
_MENTION = re.compile(r"(?<![\w@./:+-])@(?:\[([^\[\]\s]{1,64})\]|([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?![\w@.-]))")
_USERNAME = re.compile(r"[^\[\]\s]{1,64}")


def mentionable_username(username: str) -> bool:
    return bool(_USERNAME.fullmatch(username))


def mentioned_usernames(body: str) -> set[str]:
    prose = _NON_PROSE.sub(" ", body)
    return {(match.group(1) or match.group(2).rstrip(".")).lower() for match in _MENTION.finditer(prose)}
