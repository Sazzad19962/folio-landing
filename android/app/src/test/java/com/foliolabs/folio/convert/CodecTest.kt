package com.foliolabs.folio.convert

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

class CodecTest {
    private val book = Book(
        title = "Field Notes on Design",
        author = "A. Writer",
        blocks = listOf(
            Block.Paragraph("A short preface & some <markup> to escape."),
            Block.Heading(1, "Chapter One"),
            Block.Paragraph("It was a bright cold day in April."),
            Block.Heading(2, "A Section"),
            Block.Paragraph("Text with \"quotes\" and 'apostrophes'."),
            Block.Heading(1, "Chapter Two"),
            Block.Paragraph("The end."),
        ),
    )

    private fun bytes(write: (java.io.OutputStream) -> Unit) = ByteArrayOutputStream().also(write).toByteArray()

    @Test
    fun epubRoundTripKeepsTextHeadingsAndMetadata() {
        val epub = bytes { EpubCodec.write(book, it) }
        val read = EpubCodec.read(epub, "fallback")

        assertEquals("Field Notes on Design", read.title)
        assertEquals("A. Writer", read.author)
        val texts = read.blocks.map { it.text }
        for (block in book.blocks) assertTrue("missing: ${block.text}", block.text in texts)
        assertTrue(read.blocks.any { it is Block.Heading && it.text == "Chapter Two" })
    }

    @Test
    fun epubStoresMimetypeFirstAndUncompressed() {
        val epub = bytes { EpubCodec.write(book, it) }
        ZipInputStream(epub.inputStream()).use { zip ->
            val first = zip.nextEntry!!
            assertEquals("mimetype", first.name)
            assertEquals(ZipEntry.STORED, first.method)
            assertEquals("application/epub+zip", String(zip.readBytes()))
        }
    }

    @Test
    fun epubSplitsChaptersOnTopLevelHeadings() {
        val epub = bytes { EpubCodec.write(book, it) }
        val names = Zip.read(epub).keys
        assertTrue(names.containsAll(listOf("OEBPS/chapter-1.xhtml", "OEBPS/chapter-2.xhtml", "OEBPS/chapter-3.xhtml")))
        assertTrue("OEBPS/chapter-4.xhtml" !in names)
    }

    @Test
    fun docxRoundTripKeepsHeadingLevels() {
        val docx = bytes { DocxCodec.write(book, it) }
        val read = DocxCodec.read(docx, "fallback")

        assertEquals("Field Notes on Design", read.title)
        assertEquals("A. Writer", read.author)
        assertTrue(read.blocks.contains(Block.Heading(1, "Chapter One")))
        assertTrue(read.blocks.contains(Block.Heading(2, "A Section")))
        assertTrue(read.blocks.contains(Block.Paragraph("Text with \"quotes\" and 'apostrophes'.")))
    }

    @Test
    fun txtJoinsWrappedLinesAndSplitsOnBlankLines() {
        val input = "First line\nwraps here.\r\n\r\nSecond paragraph.\n\n\n"
        val read = TxtCodec.read(input.toByteArray(), "notes")
        assertEquals(listOf(Block.Paragraph("First line wraps here."), Block.Paragraph("Second paragraph.")), read.blocks)
        assertEquals("notes", read.title)
    }

    @Test
    fun txtWriteIncludesTitleAndBody() {
        val text = String(bytes { TxtCodec.write(book, it) })
        assertTrue(text.startsWith("Field Notes on Design\nA. Writer\n"))
        assertTrue(text.contains("Chapter One\n\nIt was a bright cold day in April."))
    }

    @Test
    fun pdfParagraphsMendHyphensAndDropPageNumbers() {
        val raw = " The quick brown fox jum-\nped over the\nlazy dog.\n 12\n Next para."
        assertEquals(
            listOf("The quick brown fox jumped over the lazy dog.", "Next para."),
            PdfCodec.paragraphsFrom(raw),
        )
    }

    @Test(expected = ConversionException::class)
    fun garbageZipIsRejectedWithFriendlyError() {
        EpubCodec.read("not a zip".toByteArray(), "x")
    }

    @Test
    fun xmlEscapingDropsControlCharacters() {
        assertEquals("a&amp;b&lt;c", Text.xml("a&b<\u0000c"))
    }
}
