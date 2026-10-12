package com.foliolabs.folio.convert

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.parser.Parser
import java.io.OutputStream
import java.net.URLDecoder
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

/** EPUB 2 and 3 in; EPUB 3 (with an EPUB 2 table of contents for older readers) out. */
object EpubCodec {
    private val headingTags = setOf("h1", "h2", "h3", "h4", "h5", "h6")
    private val skipTags = setOf("script", "style", "nav", "head", "svg", "math")
    private val blockTags = setOf(
        "p", "div", "li", "blockquote", "pre", "dd", "dt", "figcaption", "td", "th",
        "section", "article", "header", "footer", "aside", "main", "ul", "ol", "dl",
        "table", "tbody", "thead", "tr", "figure", "body",
    ) + headingTags

    // ---------- Reading ----------

    fun read(bytes: ByteArray, fallbackTitle: String): Book {
        val files = Zip.read(bytes)
        val container = files["META-INF/container.xml"]
            ?: throw ConversionException("This doesn't look like an EPUB (no META-INF/container.xml).")
        val opfPath = xml(container).selectFirst("rootfile")?.attr("full-path")
            ?.takeIf { it.isNotBlank() }
            ?: throw ConversionException("This EPUB is missing its package file.")
        val opf = xml(files[opfPath] ?: throw ConversionException("This EPUB is missing $opfPath."))
        val baseDir = opfPath.substringBeforeLast('/', "")

        if (isDrmProtected(files)) {
            throw ConversionException("This EPUB is DRM-protected. Folio only converts DRM-free books.")
        }

        val manifest = opf.select("manifest > item").associateBy { it.attr("id") }
        val blocks = mutableListOf<Block>()
        for (itemref in opf.select("spine > itemref")) {
            if (itemref.attr("linear") == "no") continue
            val item = manifest[itemref.attr("idref")] ?: continue
            if (item.attr("properties").split(' ').contains("nav")) continue
            val path = resolve(baseDir, item.attr("href"))
            val html = files[path] ?: continue
            val body = Jsoup.parse(String(html, Charsets.UTF_8)).body()
            collect(body, blocks)
        }
        if (blocks.isEmpty()) throw ConversionException("This EPUB has no readable text.")

        val title = opf.selectFirst("metadata > dc|title")?.text()?.takeIf { it.isNotBlank() } ?: fallbackTitle
        val author = opf.selectFirst("metadata > dc|creator")?.text()?.takeIf { it.isNotBlank() }
        val language = opf.selectFirst("metadata > dc|language")?.text()?.takeIf { it.isNotBlank() } ?: "en"
        return Book(title, author, blocks, language)
    }

    /** Obfuscated fonts are allowed; encrypted text documents (or Adobe rights.xml) mean DRM. */
    private fun isDrmProtected(files: Map<String, ByteArray>): Boolean {
        if (files.containsKey("META-INF/rights.xml")) return true
        val encryption = files["META-INF/encryption.xml"] ?: return false
        return xml(encryption).getAllElements()
            .filter { it.tagName().substringAfter(':') == "CipherReference" }
            .map { it.attr("URI").lowercase() }
            .any { it.endsWith(".xhtml") || it.endsWith(".html") || it.endsWith(".htm") || it.endsWith(".xml") }
    }

    /** Emits one block per element that holds text but no nested blocks. */
    private fun collect(el: Element, out: MutableList<Block>) {
        for (child in el.children()) {
            val tag = child.normalName()
            when {
                tag in skipTags -> Unit
                tag in headingTags -> Text.clean(child.text()).takeIf { it.isNotEmpty() }
                    ?.let { out += Block.Heading(tag[1].digitToInt(), it) }
                tag in blockTags && child.children().any { it.normalName() in blockTags } -> {
                    Text.clean(child.ownText()).takeIf { it.isNotEmpty() }?.let { out += Block.Paragraph(it) }
                    collect(child, out)
                }
                tag in blockTags -> Text.clean(child.text()).takeIf { it.isNotEmpty() }
                    ?.let { out += Block.Paragraph(it) }
                else -> Text.clean(child.text()).takeIf { it.isNotEmpty() }?.let { out += Block.Paragraph(it) }
            }
        }
    }

    private fun resolve(baseDir: String, href: String): String {
        val decoded = URLDecoder.decode(href.substringBefore('#'), "UTF-8")
        val parts = (if (baseDir.isEmpty()) decoded else "$baseDir/$decoded").split('/')
        val stack = ArrayDeque<String>()
        for (p in parts) {
            when (p) {
                "", "." -> Unit
                ".." -> stack.removeLastOrNull()
                else -> stack.addLast(p)
            }
        }
        return stack.joinToString("/")
    }

    private fun xml(bytes: ByteArray) = Jsoup.parse(String(bytes, Charsets.UTF_8), "", Parser.xmlParser())

    // ---------- Writing ----------

    private data class Chapter(val title: String, val blocks: List<Block>)

    fun write(book: Book, out: OutputStream) {
        val chapters = splitChapters(book)
        val id = "urn:uuid:${UUID.randomUUID()}"
        val modified = Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()
        val lang = Text.xml(book.language)

        val entries = mutableListOf<Pair<String, ByteArray>>()
        entries += "mimetype" to "application/epub+zip".toByteArray(Charsets.US_ASCII)
        entries += "META-INF/container.xml" to """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>""".toByteArray()

        chapters.forEachIndexed { i, chapter ->
            entries += "OEBPS/chapter-${i + 1}.xhtml" to chapterXhtml(book, chapter, i == 0, lang).toByteArray()
        }

        val manifest = buildString {
            append("""<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>""")
            append("""<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>""")
            append("""<item id="css" href="style.css" media-type="text/css"/>""")
            chapters.indices.forEach { append("""<item id="c${it + 1}" href="chapter-${it + 1}.xhtml" media-type="application/xhtml+xml"/>""") }
        }
        val spine = chapters.indices.joinToString("") { """<itemref idref="c${it + 1}"/>""" }
        val creator = book.author?.let { "<dc:creator>${Text.xml(it)}</dc:creator>" } ?: ""
        entries += "OEBPS/content.opf" to """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="$lang">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">$id</dc:identifier><dc:title>${Text.xml(book.title)}</dc:title>$creator<dc:language>$lang</dc:language><meta property="dcterms:modified">$modified</meta></metadata>
<manifest>$manifest</manifest>
<spine toc="ncx">$spine</spine>
</package>""".toByteArray()

        val navItems = chapters.withIndex().joinToString("") { (i, c) -> """<li><a href="chapter-${i + 1}.xhtml">${Text.xml(c.title)}</a></li>""" }
        entries += "OEBPS/nav.xhtml" to """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="$lang" xml:lang="$lang"><head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>$navItems</ol></nav></body></html>""".toByteArray()

        val navPoints = chapters.withIndex().joinToString("") { (i, c) ->
            """<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${Text.xml(c.title)}</text></navLabel><content src="chapter-${i + 1}.xhtml"/></navPoint>"""
        }
        entries += "OEBPS/toc.ncx" to """<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="$id"/></head><docTitle><text>${Text.xml(book.title)}</text></docTitle><navMap>$navPoints</navMap></ncx>""".toByteArray()

        entries += "OEBPS/style.css" to STYLE.toByteArray()
        Zip.write(out, entries, stored = setOf("mimetype"))
    }

    /** One chapter per top-level heading; text before the first heading becomes an opening chapter. */
    private fun splitChapters(book: Book): List<Chapter> {
        val blocks = book.bodyBlocks
        val topLevel = blocks.filterIsInstance<Block.Heading>().minOfOrNull { it.level }
        if (topLevel == null) return listOf(Chapter(book.title, blocks))

        val chapters = mutableListOf<Chapter>()
        var title = book.title
        var current = mutableListOf<Block>()
        for (block in blocks) {
            if (block is Block.Heading && block.level == topLevel) {
                if (current.isNotEmpty()) chapters += Chapter(title, current)
                title = block.text
                current = mutableListOf(block)
            } else {
                current += block
            }
        }
        if (current.isNotEmpty()) chapters += Chapter(title, current)
        return chapters
    }

    private fun chapterXhtml(book: Book, chapter: Chapter, first: Boolean, lang: String): String {
        val body = StringBuilder()
        if (first) {
            body.append("<header class=\"title\"><h1>${Text.xml(book.title)}</h1>")
            book.author?.let { body.append("<p class=\"author\">${Text.xml(it)}</p>") }
            body.append("</header>")
        }
        for (block in chapter.blocks) {
            when (block) {
                is Block.Heading -> {
                    // Keep the book title as the only h1 on the first page.
                    val level = (if (first) block.level + 1 else block.level).coerceIn(1, 6)
                    body.append("<h$level>${Text.xml(block.text)}</h$level>")
                }
                is Block.Paragraph -> body.append("<p>${Text.xml(block.text)}</p>")
            }
        }
        return """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="$lang" xml:lang="$lang">
<head><meta charset="utf-8"/><title>${Text.xml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter">$body</section></body></html>"""
    }

    private const val STYLE = """body { font-family: Georgia, serif; line-height: 1.55; margin: 0 5%; }
h1, h2, h3, h4, h5, h6 { font-family: sans-serif; line-height: 1.2; page-break-after: avoid; }
h1 { font-size: 1.6em; margin: 1.5em 0 0.8em; }
h2 { font-size: 1.3em; margin: 1.4em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1.2em 0 0.5em; }
p { margin: 0 0 0.8em; }
header.title { margin: 3em 0 2em; }
header.title h1 { font-size: 2em; margin: 0 0 0.3em; }
p.author { color: #4A5260; font-size: 1.1em; }
"""
}
