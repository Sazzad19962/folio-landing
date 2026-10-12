package com.foliolabs.folio.convert

/**
 * The format-neutral middle step of every conversion: each reader turns a file
 * into a [Book], and each writer turns a [Book] into a file.
 */
data class Book(
    val title: String,
    val author: String?,
    val blocks: List<Block>,
    val language: String = "en",
) {
    /** Blocks without a leading heading that only repeats the title. */
    val bodyBlocks: List<Block>
        get() {
            val first = blocks.firstOrNull()
            return if (first is Block.Heading && first.text.equals(title, ignoreCase = true)) blocks.drop(1) else blocks
        }
}

sealed interface Block {
    val text: String

    data class Heading(val level: Int, override val text: String) : Block
    data class Paragraph(override val text: String) : Block
}

enum class Format(val label: String, val extension: String, val mimeType: String) {
    PDF("PDF", "pdf", "application/pdf"),
    EPUB("EPUB", "epub", "application/epub+zip"),
    DOCX("DOCX", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    TXT("TXT", "txt", "text/plain");

    companion object {
        /** MIME types offered in the system file picker. */
        val pickerMimeTypes: Array<String> =
            entries.map { it.mimeType }.toTypedArray() + "application/octet-stream"

        fun fromFileName(name: String): Format? =
            entries.firstOrNull { name.endsWith(".${it.extension}", ignoreCase = true) }

        fun fromMimeType(mimeType: String?): Format? =
            entries.firstOrNull { it.mimeType == mimeType }

        /** Sensible default target when a file of [source] is picked. */
        fun defaultTargetFor(source: Format): Format = when (source) {
            PDF, TXT -> EPUB
            EPUB, DOCX -> PDF
        }
    }
}

class ConversionException(message: String) : Exception(message)

internal object Text {
    private val spaces = Regex("[ \\t\\u00A0]+")

    /** Collapses runs of spaces and trims. */
    fun clean(s: String): String = s.replace(spaces, " ").trim()

    /** Escapes text for XML and drops characters XML 1.0 does not allow. */
    fun xml(s: String): String {
        val sb = StringBuilder(s.length + 16)
        for (c in s) {
            when {
                c == '&' -> sb.append("&amp;")
                c == '<' -> sb.append("&lt;")
                c == '>' -> sb.append("&gt;")
                c == '"' -> sb.append("&quot;")
                c == '\'' -> sb.append("&apos;")
                c < ' ' && c != '\t' && c != '\n' && c != '\r' -> Unit
                c == '￾' || c == '￿' -> Unit
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }
}
