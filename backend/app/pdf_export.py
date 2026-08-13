"""
Shared PDF builder for a single request's full "detail certificate" export --
every field plus its complete approval/workflow history (who acted, what they
decided, and when), as one downloadable PDF. This is a different shape of
export than routers/export.py's Download & Export Centre: that one streams
many rows of one report/screen (Excel/PDF/CSV); this one renders one record
in full, the way you'd hand someone a printed copy of the request for an
audit or a change-management ticket.

Each router builds its own `sections` (grouped field lists, mirroring the
same DetailSection groupings already used on that module's Overview tab in
the frontend) and `history` (from the same qap_approval_actions log every
module already writes to and already shows on its own History tab), then
hands them to build_request_detail_pdf below -- so the reportlab boilerplate
(styles, table formatting, page setup) lives in exactly one place.
"""
import io
import re
from dataclasses import dataclass
from xml.sax.saxutils import escape
from typing import Iterable, List, Optional, Sequence, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

_styles = getSampleStyleSheet()
_section_title_style = ParagraphStyle(
    "DetailSectionTitle", parent=_styles["Heading3"],
    spaceBefore=12, spaceAfter=5, textColor=colors.HexColor("#1f2937"), fontSize=11,
)
_meta_style = ParagraphStyle("DetailMeta", parent=_styles["Normal"], textColor=colors.HexColor("#4b5563"), fontSize=8.5)

Field = Tuple[str, object]
Section = Tuple[str, Sequence[Field]]
HistoryRow = Tuple[str, str, str, str, str, str]


@dataclass(frozen=True)
class RichTextValue:
    """Markdown-backed field that should retain formatting in PDF exports."""
    markdown: str


def _fmt(value: object) -> str:
    if value is None or value == "":
        return "—"
    # ReportLab Paragraph parses a small XML/HTML dialect. Request content is
    # user-authored and rich-text fields are stored as Markdown, so raw values
    # containing <, >, &, links, code, or Markdown tables must never be handed
    # to Paragraph as markup. Escape first and retain intentional line breaks.
    return escape(str(value)).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br/>")


def _safe_text(value: object) -> str:
    return escape(str(value))


def _markdown_inline(value: str) -> str:
    """Convert the editor's safe inline Markdown subset to ReportLab tags."""
    rendered = escape(value)
    rendered = re.sub(r"\[u\]([\s\S]+?)\[/u\]", r"<u>\1</u>", rendered)
    rendered = re.sub(r"\*\*([\s\S]+?)\*\*", r"<b>\1</b>", rendered)
    rendered = re.sub(r"~~([\s\S]+?)~~", r"<strike>\1</strike>", rendered)
    rendered = re.sub(r"`([^`]+)`", r"<font name=\"Courier\">\1</font>", rendered)
    rendered = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", rendered)
    # Keep link text readable without putting an untrusted URL into ReportLab
    # markup. The full URL remains visible in parentheses for printed copies.
    rendered = re.sub(r"\[([^\]]+)\]\((https?://[^)]+|mailto:[^)]+)\)", r"\1 (\2)", rendered, flags=re.I)
    return rendered


def _markdown_cells(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip().replace(r"\|", "|") for cell in re.split(r"(?<!\\)\|", value)]


_TABLE_SEPARATOR = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$")


def _rich_text_flowables(markdown: str, available_width: float = 320) -> list:
    """Render paragraphs and Markdown tables as native ReportLab flowables."""
    if not markdown.strip():
        return [Paragraph("—", _styles["Normal"])]
    lines = markdown.replace("\r", "").split("\n")
    flowables: list = []
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            content = "<br/>".join(_markdown_inline(line) for line in paragraph)
            flowables.append(Paragraph(content, _styles["Normal"]))
            paragraph.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        if line.strip() and "|" in line and index + 1 < len(lines) and _TABLE_SEPARATOR.match(lines[index + 1]):
            flush_paragraph()
            rows = [_markdown_cells(line)]
            index += 2
            while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                rows.append(_markdown_cells(lines[index]))
                index += 1
            width = max(len(row) for row in rows)
            normalized = [row + [""] * (width - len(row)) for row in rows]
            table_data = [[Paragraph(_markdown_inline(cell), _styles["Normal"]) for cell in row] for row in normalized]
            nested = Table(
                table_data, colWidths=[available_width / width] * width,
                repeatRows=1, splitByRow=1, splitInRow=1,
            )
            nested.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8edf2")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#263442")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#aeb8c3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            flowables.append(nested)
            continue
        if not line.strip():
            flush_paragraph()
            if flowables:
                flowables.append(Spacer(1, 3))
        else:
            paragraph.append(line)
        index += 1
    flush_paragraph()
    if flowables and isinstance(flowables[-1], Spacer):
        flowables.pop()
    return flowables or [Paragraph("—", _styles["Normal"])]


def _field_content(value: object):
    if isinstance(value, RichTextValue):
        return _rich_text_flowables(value.markdown)
    return Paragraph(_fmt(value), _styles["Normal"])


def _detail_table(data: list[list]) -> Table:
    """Build the normal two-column field table.

    Rich-text values are deliberately excluded by the caller: a ReportLab
    table row is atomic, so one long Paragraph/list inside that row cannot
    continue on the next page and raises LayoutError. Normal short metadata
    keeps the compact two-column layout.
    """
    table = Table(data, colWidths=[150, 330], splitByRow=1, splitInRow=1)
    table.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9dce3")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f3f4f8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def _rich_field_label(label: str) -> Table:
    table = Table([[Paragraph(f"<b>{_safe_text(label)}</b>", _styles["Normal"])]], colWidths=[480])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f3f4f8")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9dce3")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def build_request_detail_pdf(
    *, title: str, subtitle: str, sections: Iterable[Section],
    history: Sequence[HistoryRow], generated_by: str, generated_at: str,
    history_note: Optional[str] = None,
    history_title: Optional[str] = "Workflow / Approval History — Who Signed",
) -> io.BytesIO:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, topMargin=16 * mm, bottomMargin=16 * mm, leftMargin=16 * mm, rightMargin=16 * mm,
        title=title,
    )
    elements: List = [
        Paragraph(_safe_text(title), _styles["Title"]),
        Paragraph(_safe_text(subtitle), _styles["Normal"]),
        Paragraph(_safe_text(f"Generated by {generated_by} on {generated_at}"), _meta_style),
        Spacer(1, 10),
    ]

    for section_title, fields in sections:
        elements.append(Paragraph(_safe_text(section_title), _section_title_style))
        pending_rows: list[list] = []

        def flush_rows() -> None:
            if pending_rows:
                elements.append(_detail_table(pending_rows[:]))
                pending_rows.clear()

        for label, value in fields:
            if isinstance(value, RichTextValue):
                flush_rows()
                elements.append(_rich_field_label(label))
                # Paragraphs and nested Markdown tables are top-level
                # flowables here, so ReportLab may split them naturally over
                # as many pages as required.
                elements.extend(_rich_text_flowables(value.markdown, available_width=470))
                elements.append(Spacer(1, 5))
            else:
                pending_rows.append([Paragraph(_safe_text(label), _styles["Normal"]), _field_content(value)])
        flush_rows()
        elements.append(Spacer(1, 6))

    if history_title:
        elements.append(Paragraph(_safe_text(history_title), _section_title_style))
        if history_note:
            elements.append(Paragraph(_fmt(history_note), _meta_style))
            elements.append(Spacer(1, 4))
        if history:
            head = ["Step", "Decision", "Actor", "Role", "Comments", "When"]
            rows = [[Paragraph(_fmt(c), _styles["Normal"]) for c in row] for row in history]
            t = Table(
                [head] + rows, repeatRows=1, colWidths=[70, 60, 75, 65, 140, 70],
                splitByRow=1, splitInRow=1,
            )
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            elements.append(t)
        else:
            elements.append(Paragraph("No workflow history recorded yet.", _styles["Normal"]))

    doc.build(elements)
    buf.seek(0)
    return buf
