package com.foliolabs.folio.convert

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.IOException
import java.io.OutputStream

/** PDF text in via PdfBox-Android; PDF out via Android's built-in [PdfDocument]. */
object PdfCodec {
    private const val PARAGRAPH = " "

    @Volatile
    private var pdfBoxReady = false

    fun read(context: Context, bytes: ByteArray, fallbackTitle: String): Book {
        if (!pdfBoxReady) {
            PDFBoxResourceLoader.init(context.applicationContext)
            pdfBoxReady = true
        }
        val document = try {
            PDDocument.load(bytes)
        } catch (e: InvalidPasswordException) {
            throw ConversionException("This PDF is password-protected. Remove the password and try again.")
        } catch (e: IOException) {
            throw ConversionException("This PDF couldn't be opened. It may be damaged.")
        }
        document.use { doc ->
            val stripper = PDFTextStripper().apply {
                paragraphStart = PARAGRAPH
                lineSeparator = "\n"
            }
            val paragraphs = paragraphsFrom(stripper.getText(doc))
            if (paragraphs.isEmpty()) {
                throw ConversionException("No selectable text found. This looks like a scanned PDF, which Folio can't read yet.")
            }
            val info = doc.documentInformation
            val title = info?.title?.takeIf { it.isNotBlank() } ?: fallbackTitle
            val author = info?.author?.takeIf { it.isNotBlank() }
            return Book(title, author, paragraphs.map { Block.Paragraph(it) })
        }
    }

    /** Joins wrapped lines, mends end-of-line hyphenation and drops bare page numbers. */
    internal fun paragraphsFrom(raw: String): List<String> =
        raw.split(PARAGRAPH, "\n\n")
            .map { chunk ->
                val lines = chunk.lines().map { it.trim() }.filter { it.isNotEmpty() }
                val sb = StringBuilder()
                for (line in lines) {
                    if (sb.isEmpty()) {
                        sb.append(line)
                    } else if (sb.endsWith("-") && line.first().isLowerCase()) {
                        sb.setLength(sb.length - 1)
                        sb.append(line)
                    } else {
                        sb.append(' ').append(line)
                    }
                }
                Text.clean(sb.toString())
            }
            .filter { it.isNotEmpty() && !it.all(Char::isDigit) }

    // ---------- Writing ----------

    private const val PAGE_WIDTH = 420 // A5 in PostScript points
    private const val PAGE_HEIGHT = 595
    private const val MARGIN = 48f
    private const val FOOTER = 22f

    fun write(book: Book, out: OutputStream) {
        val ink = Color.rgb(0x10, 0x15, 0x1F)
        val body = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = ink; textSize = 10.5f; typeface = Typeface.SERIF
        }
        val headings = (1..6).associateWith { level ->
            TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = ink
                textSize = when (level) { 1 -> 17f; 2 -> 14f; else -> 12f }
                typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            }
        }
        val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = ink; textSize = 26f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        val mutedPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(0x4A, 0x52, 0x60); textSize = 12f; typeface = Typeface.SANS_SERIF
        }
        val footerPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(0x4A, 0x52, 0x60); textSize = 8f; textAlign = Paint.Align.CENTER
        }

        val width = (PAGE_WIDTH - 2 * MARGIN).toInt()
        val bottom = PAGE_HEIGHT - MARGIN - FOOTER
        val pdf = PdfDocument()
        var pageNumber = 0
        var page: PdfDocument.Page? = null
        var y = MARGIN

        fun finishPage() {
            page?.let {
                it.canvas.drawText("$pageNumber", PAGE_WIDTH / 2f, PAGE_HEIGHT - MARGIN + 8f, footerPaint)
                pdf.finishPage(it)
            }
        }

        fun newPage(): Canvas {
            finishPage()
            pageNumber++
            page = pdf.startPage(PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pageNumber).create())
            y = MARGIN
            return page!!.canvas
        }

        fun layout(text: String, paint: TextPaint, spacing: Float = 1.3f) =
            StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setLineSpacing(0f, spacing)
                .setIncludePad(false)
                .build()

        /** Draws [layout] line by line, starting new pages as needed. */
        fun draw(layout: StaticLayout, spaceAfter: Float) {
            var line = 0
            while (line < layout.lineCount) {
                if (page == null || y + (layout.getLineBottom(line) - layout.getLineTop(line)) > bottom) newPage()
                val canvas = page!!.canvas
                val first = line
                var height = 0f
                while (line < layout.lineCount) {
                    val h = (layout.getLineBottom(line) - layout.getLineTop(line)).toFloat()
                    if (y + height + h > bottom && line > first) break
                    height += h
                    line++
                }
                val top = layout.getLineTop(first).toFloat()
                canvas.save()
                canvas.translate(MARGIN, y - top)
                canvas.clipRect(0f, top, width.toFloat(), top + height)
                layout.draw(canvas)
                canvas.restore()
                y += height
            }
            y += spaceAfter
        }

        // Title page
        newPage()
        y = PAGE_HEIGHT * 0.3f
        draw(layout(book.title, titlePaint, 1.1f), 12f)
        book.author?.let { draw(layout(it, mutedPaint), 0f) }

        // Body starts on a fresh page
        newPage()
        for (block in book.bodyBlocks) {
            when (block) {
                is Block.Heading -> {
                    val headingLayout = layout(block.text, headings.getValue(block.level.coerceIn(1, 6)), 1.15f)
                    // Keep a heading with at least three lines of what follows.
                    if (y > MARGIN && y + headingLayout.height + 3 * body.fontSpacing * 1.3f > bottom) newPage()
                    if (y > MARGIN) y += 10f
                    draw(headingLayout, 8f)
                }
                is Block.Paragraph -> draw(layout(block.text, body), 7f)
            }
        }
        finishPage()
        try {
            pdf.writeTo(out)
        } finally {
            pdf.close()
        }
    }
}
