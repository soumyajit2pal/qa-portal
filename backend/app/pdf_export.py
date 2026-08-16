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
from reportlab.platypus import CondPageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

_styles = getSampleStyleSheet()
_section_title_style = ParagraphStyle(
    "DetailSectionTitle", parent=_styles["Heading3"],
    spaceBefore=14, spaceAfter=7, textColor=colors.HexColor("#173f48"), fontSize=11,
    leading=14,
)
_meta_style = ParagraphStyle("DetailMeta", parent=_styles["Normal"], textColor=colors.HexColor("#62777c"), fontSize=8.5, leading=11)
_body_style = ParagraphStyle("DetailBody", parent=_styles["Normal"], fontSize=8.5, leading=11, textColor=colors.HexColor("#314f56"), splitLongWords=True)
_label_style = ParagraphStyle("DetailLabel", parent=_body_style, fontName="Helvetica-Bold", textColor=colors.HexColor("#31545b"))
_history_style = ParagraphStyle("DetailHistory", parent=_body_style, fontSize=7.3, leading=9)
_history_header_style = ParagraphStyle("DetailHistoryHeader", parent=_history_style, fontName="Helvetica-Bold", textColor=colors.white)

_PAGE_MARGIN = 16 * mm
_CONTENT_WIDTH = A4[0] - (2 * _PAGE_MARGIN)

Field = Tuple[str, object]
Section = Tuple[str, Sequence[Field]]
HistoryRow = Tuple[str, str, str, str, str, str]


@dataclass(frozen=True)
class RichTextValue:
    """Markdown-backed field that should retain formatting in PDF exports."""
    markdown: str


@dataclass(frozen=True)
class SignatureValue:
    """Structured electronic-signature evidence rendered as a signed card."""
    signer: str
    signature_id: str
    applied_at: str
    intent: str
    stage: str
    style: str = "professional"


_ELECTRONIC_SIGNATURE = re.compile(
    r"\[Electronic signature \| Signer: (?P<signer>.*?) \| Applied: (?P<applied_at>.*?) "
    r"\| Signature ID: (?P<signature_id>.*?)(?: \| Style: (?P<style>professional|classic|handwritten))? "
    r"\| Intent: (?P<intent>.*?)\]",
    re.S,
)


def parse_electronic_signature(value: Optional[str], *, stage: str = "Approval") -> Optional[SignatureValue]:
    """Read signature evidence written by the shared frontend approval flow."""
    match = _ELECTRONIC_SIGNATURE.search(value or "")
    if not match:
        return None
    values = {
        key: item.strip() if item else item
        for key, item in match.groupdict().items()
    }
    values["style"] = values.get("style") or "professional"
    return SignatureValue(stage=stage, **values)


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
        return [Paragraph("—", _body_style)]
    lines = markdown.replace("\r", "").split("\n")
    flowables: list = []
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            content = "<br/>".join(_markdown_inline(line) for line in paragraph)
            flowables.append(Paragraph(content, _body_style))
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
            table_data = [[Paragraph(_markdown_inline(cell), _body_style) for cell in row] for row in normalized]
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
    return flowables or [Paragraph("—", _body_style)]


def _field_content(value: object):
    if isinstance(value, RichTextValue):
        return _rich_text_flowables(value.markdown)
    return Paragraph(_fmt(value), _body_style)


def _detail_table(data: list[list], available_width: float) -> Table:
    """Build the normal two-column field table.

    Rich-text values are deliberately excluded by the caller: a ReportLab
    table row is atomic, so one long Paragraph/list inside that row cannot
    continue on the next page and raises LayoutError. Normal short metadata
    keeps the compact two-column layout.
    """
    table = Table(data, colWidths=[available_width * .31, available_width * .69], splitByRow=1, splitInRow=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9dce3")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f3f4f8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _rich_field_block(label: str, value: RichTextValue, available_width: float) -> list:
    """Render a full-width rich field without nesting page-splittable tables.

    ReportLab 4.2.5 cannot split an outer table cell containing a Markdown
    ``Table`` and fails with ``AttributeError: Table has no attribute height``.
    The label, prose blocks, and Markdown grids therefore remain sibling
    flowables. Prose is placed in a one-cell table so its full-width border and
    padding stay visually aligned with the field label; Markdown tables remain
    native top-level tables and can repeat their header across pages.
    """
    label_table = Table(
        [[Paragraph(_safe_text(label), _label_style)]],
        colWidths=[available_width], splitByRow=1, splitInRow=1, hAlign="LEFT",
    )
    label_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f3f6f7")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cddcdf")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    flowables: list = [label_table]
    for content in _rich_text_flowables(value.markdown, available_width=available_width):
        if isinstance(content, (Table, Spacer)):
            flowables.append(content)
            continue
        prose_table = Table(
            [[content]], colWidths=[available_width],
            splitByRow=1, splitInRow=1, hAlign="LEFT",
        )
        prose_table.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cddcdf")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        flowables.append(prose_table)
    return flowables


def _signature_block(label: str, value: SignatureValue, available_width: float) -> list:
    signature_fonts = {
        "professional": ("Helvetica-Bold", 14, 18),
        "classic": ("Times-BoldItalic", 16, 19),
        "handwritten": ("Times-Italic", 18, 21),
    }
    signature_font, signature_size, signature_leading = signature_fonts.get(
        value.style, signature_fonts["professional"]
    )
    signature_name_style = ParagraphStyle(
        "SignatureName", parent=_body_style, fontName=signature_font,
        fontSize=signature_size, leading=signature_leading,
        textColor=colors.HexColor("#0b6677"),
    )
    signature_meta_style = ParagraphStyle(
        "SignatureMeta", parent=_body_style, fontSize=7.8, leading=10,
        textColor=colors.HexColor("#526c72"),
    )
    signature_id_style = ParagraphStyle(
        "SignatureId", parent=signature_meta_style, fontName="Courier-Bold",
        fontSize=7.5, splitLongWords=True,
    )
    # Keep this as one flat table. ReportLab 4.2.5 raises AttributeError
    # while page-splitting a Table nested inside another Table cell because
    # the child table has no computed ``height`` yet (the production
    # /api/signoffs/{id}/export traceback). Four proportional columns plus
    # SPAN commands reproduce the same two-column signature card without any
    # nested flowable.
    widths = [available_width * .27, available_width * .27, available_width * .23, available_width * .23]
    block = Table([
        [Paragraph(_safe_text(label), _label_style), "", "", ""],
        [Paragraph("ELECTRONICALLY SIGNED BY", signature_meta_style), "",
         Paragraph("SIGNATURE ID", signature_meta_style), ""],
        [Paragraph(_safe_text(value.signer), signature_name_style), "",
         Paragraph(_safe_text(value.signature_id), signature_id_style), ""],
        [Paragraph(f"Stage: <b>{_safe_text(value.stage)}</b>", signature_meta_style),
         Paragraph(f"Applied: {_safe_text(value.applied_at)}", signature_meta_style),
         Paragraph(f"Intent: {_safe_text(value.intent)}", signature_meta_style), ""],
    ], colWidths=widths, splitByRow=1, splitInRow=0, hAlign="LEFT")
    block.setStyle(TableStyle([
        ("SPAN", (0, 0), (-1, 0)),
        ("SPAN", (0, 1), (1, 1)), ("SPAN", (2, 1), (3, 1)),
        ("SPAN", (0, 2), (1, 2)), ("SPAN", (2, 2), (3, 2)),
        ("SPAN", (2, 3), (3, 3)),
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#eaf5ef")),
        ("BOX", (0, 0), (-1, -1), .7, colors.HexColor("#83b99a")),
        ("LINEBELOW", (0, 0), (0, 0), .5, colors.HexColor("#a8cdb5")),
        ("LINEABOVE", (0, 3), (-1, 3), .35, colors.HexColor("#c9dadd")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    # A signature is one audit record. Reserve enough room for the entire card
    # before rendering it so the stage/timestamp/intent cannot be orphaned on
    # the next page. CondPageBreak avoids ReportLab 4.2.5's KeepTogether/Table
    # pagination loop.
    return [CondPageBreak(48 * mm), block]


def _page_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d8e5e7"))
    canvas.setLineWidth(.4)
    canvas.line(doc.leftMargin, 10.5 * mm, A4[0] - doc.rightMargin, 10.5 * mm)
    canvas.setFillColor(colors.HexColor("#71868b"))
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(doc.leftMargin, 7 * mm, "QualityOps - Controlled PDF export")
    canvas.drawRightString(A4[0] - doc.rightMargin, 7 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build_request_detail_pdf(
    *, title: str, subtitle: str, sections: Iterable[Section],
    history: Sequence[HistoryRow], generated_by: str, generated_at: str,
    history_note: Optional[str] = None,
    history_title: Optional[str] = "Workflow / Approval History — Who Signed",
) -> io.BytesIO:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, topMargin=_PAGE_MARGIN, bottomMargin=18 * mm, leftMargin=_PAGE_MARGIN, rightMargin=_PAGE_MARGIN,
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
                elements.append(_detail_table(pending_rows[:], doc.width))
                pending_rows.clear()

        for label, value in fields:
            if isinstance(value, RichTextValue):
                flush_rows()
                elements.extend(_rich_field_block(label, value, doc.width))
                elements.append(Spacer(1, 7))
            elif isinstance(value, SignatureValue):
                flush_rows()
                elements.extend(_signature_block(label, value, doc.width))
                elements.append(Spacer(1, 7))
            else:
                pending_rows.append([Paragraph(_safe_text(label), _label_style), _field_content(value)])
        flush_rows()
        elements.append(Spacer(1, 6))

    if history_title:
        elements.append(Paragraph(_safe_text(history_title), _section_title_style))
        if history_note:
            elements.append(Paragraph(_fmt(history_note), _meta_style))
            elements.append(Spacer(1, 4))
        if history:
            head = ["Step", "Decision", "Actor", "Role", "Comments", "When"]
            rows = [[Paragraph(_fmt(c), _history_style) for c in row] for row in history]
            history_widths = [doc.width * ratio for ratio in (.14, .12, .15, .14, .29, .16)]
            t = Table(
                [[Paragraph(column, _history_header_style) for column in head]] + rows,
                repeatRows=1, colWidths=history_widths,
                splitByRow=1, splitInRow=1,
            )
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7fafb")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            elements.append(t)
        else:
            elements.append(Paragraph("No workflow history recorded yet.", _styles["Normal"]))

    doc.build(elements, onFirstPage=_page_footer, onLaterPages=_page_footer)
    buf.seek(0)
    return buf
