package com.foliolabs.folio.convert

import android.content.Context
import java.io.OutputStream

class Converter(private val context: Context) {

    fun read(bytes: ByteArray, format: Format, fallbackTitle: String): Book = when (format) {
        Format.PDF -> PdfCodec.read(context, bytes, fallbackTitle)
        Format.EPUB -> EpubCodec.read(bytes, fallbackTitle)
        Format.DOCX -> DocxCodec.read(bytes, fallbackTitle)
        Format.TXT -> TxtCodec.read(bytes, fallbackTitle)
    }

    fun write(book: Book, format: Format, out: OutputStream) = when (format) {
        Format.PDF -> PdfCodec.write(book, out)
        Format.EPUB -> EpubCodec.write(book, out)
        Format.DOCX -> DocxCodec.write(book, out)
        Format.TXT -> TxtCodec.write(book, out)
    }
}
