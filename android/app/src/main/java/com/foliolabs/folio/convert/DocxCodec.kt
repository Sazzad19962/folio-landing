package com.foliolabs.folio.convert

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.parser.Parser
import java.io.OutputStream

/** Word .docx: paragraphs and headings in, paragraphs and headings out. */
object DocxCodec {
    private val headingName = Regex("(?i)^heading\\s*([1-6])$")

    fun read(bytes: ByteArray, fallbackTitle: String): Book {
        val files = Zip.read(bytes)
        val body = files["word/document.xml"]
            ?: throw ConversionException("This doesn't look like a Word document (no document body found).")
        val doc = xml(body)

        // styleId -> display name, e.g. "Heading1" -> "heading 1"
        val styleNames = files["word/styles.xml"]?.let { styles ->
            xml(styles).select("w|style").associate { it.attr("w:styleId") to (it.selectFirst("w|name")?.attr("w:val") ?: "") }
        } ?: emptyMap()

        val blocks = mutableListOf<Block>()
        for (p in doc.select("w|body w|p")) {
            val text = Text.clean(paragraphText(p))
            if (text.isEmpty()) continue
            val styleId = p.selectFirst("w|pPr > w|pStyle")?.attr("w:val").orEmpty()
            val level = headingLevel(styleId) ?: headingLevel(styleNames[styleId].orEmpty())
            blocks += if (level != null) Block.Heading(level, text) else Block.Paragraph(text)
        }
        if (blocks.isEmpty()) throw ConversionException("This Word document has no text to convert.")

        val core = files["docProps/core.xml"]?.let(::xml)
        val title = core?.selectFirst("dc|title")?.text()?.takeIf { it.isNotBlank() }
            ?: (blocks.first() as? Block.Heading)?.text
            ?: fallbackTitle
        val author = core?.selectFirst("dc|creator")?.text()?.takeIf { it.isNotBlank() }
        return Book(title, author, blocks)
    }

    private fun paragraphText(p: Element): String {
        val sb = StringBuilder()
        for (el in p.select("w|t, w|tab, w|br, w|cr")) {
            when (el.tagName()) {
                "w:t" -> sb.append(el.wholeText())
                else -> sb.append(' ')
            }
        }
        return sb.toString()
    }

    private fun headingLevel(style: String): Int? {
        if (style.equals("Title", ignoreCase = true)) return 1
        headingName.find(style.trim())?.let { return it.groupValues[1].toInt() }
        return null
    }

    private fun xml(bytes: ByteArray): Document = Jsoup.parse(String(bytes, Charsets.UTF_8), "", Parser.xmlParser())

    fun write(book: Book, out: OutputStream) {
        val body = StringBuilder()
        body.append(paragraph("Title", book.title))
        book.author?.let { body.append(paragraph("Subtitle", it)) }
        for (block in book.bodyBlocks) {
            when (block) {
                is Block.Heading -> body.append(paragraph("Heading${block.level.coerceIn(1, 3)}", block.text))
                is Block.Paragraph -> body.append(paragraph(null, block.text))
            }
        }

        val document = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="$W"><w:body>$body<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"""

        val core = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${Text.xml(book.title)}</dc:title>${book.author?.let { "<dc:creator>${Text.xml(it)}</dc:creator>" } ?: ""}</cp:coreProperties>"""

        Zip.write(
            out,
            listOf(
                "[Content_Types].xml" to CONTENT_TYPES.toByteArray(),
                "_rels/.rels" to ROOT_RELS.toByteArray(),
                "word/_rels/document.xml.rels" to DOCUMENT_RELS.toByteArray(),
                "word/document.xml" to document.toByteArray(),
                "word/styles.xml" to STYLES.toByteArray(),
                "docProps/core.xml" to core.toByteArray(),
            ),
        )
    }

    private fun paragraph(style: String?, text: String): String {
        val props = style?.let { "<w:pPr><w:pStyle w:val=\"$it\"/></w:pPr>" } ?: ""
        return "<w:p>$props<w:r><w:t xml:space=\"preserve\">${Text.xml(text)}</w:t></w:r></w:p>"
    }

    private const val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

    private const val CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"""

    private const val ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"""

    private const val DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"""

    private const val STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="$W">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="480"/></w:pPr><w:rPr><w:color w:val="4A5260"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>"""
}
