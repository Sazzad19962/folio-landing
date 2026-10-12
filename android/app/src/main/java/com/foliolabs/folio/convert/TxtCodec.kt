package com.foliolabs.folio.convert

import java.io.OutputStream

object TxtCodec {
    private val blankLine = Regex("\\n[ \\t]*\\n")

    /** Splits on blank lines; hard-wrapped lines inside a paragraph are joined so the text can reflow. */
    fun read(bytes: ByteArray, fallbackTitle: String): Book {
        val text = String(bytes, Charsets.UTF_8)
            .removePrefix("﻿")
            .replace("\r\n", "\n")
            .replace('\r', '\n')
        val blocks = text.split(blankLine)
            .map { para -> Text.clean(para.lines().joinToString(" ") { it.trim() }) }
            .filter { it.isNotEmpty() }
            .map { Block.Paragraph(it) }
        if (blocks.isEmpty()) throw ConversionException("This text file is empty.")
        return Book(fallbackTitle, null, blocks)
    }

    fun write(book: Book, out: OutputStream) {
        val sb = StringBuilder()
        sb.append(book.title).append('\n')
        book.author?.let { sb.append(it).append('\n') }
        sb.append('\n')
        for (block in book.bodyBlocks) {
            when (block) {
                is Block.Heading -> sb.append('\n').append(block.text).append("\n\n")
                is Block.Paragraph -> sb.append(block.text).append("\n\n")
            }
        }
        out.write(sb.toString().trimEnd().plus("\n").toByteArray(Charsets.UTF_8))
    }
}
