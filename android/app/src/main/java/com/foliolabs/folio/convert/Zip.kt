package com.foliolabs.folio.convert

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal object Zip {
    private const val MAX_TOTAL_BYTES = 512L * 1024 * 1024

    /** Reads every entry into memory, refusing archives that expand past 512 MB. */
    fun read(bytes: ByteArray): Map<String, ByteArray> {
        val entries = LinkedHashMap<String, ByteArray>()
        var total = 0L
        try {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (entry.isDirectory) continue
                    val out = ByteArrayOutputStream()
                    while (true) {
                        val n = zip.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > MAX_TOTAL_BYTES) throw ConversionException("This file expands to more than 512 MB and can't be converted.")
                        out.write(buffer, 0, n)
                    }
                    entries[entry.name.trimStart('/')] = out.toByteArray()
                }
            }
        } catch (e: java.util.zip.ZipException) {
            throw ConversionException("This file is damaged or isn't a valid EPUB or DOCX file.")
        }
        if (entries.isEmpty()) throw ConversionException("This file is empty or damaged.")
        return entries
    }

    /** Writes a ZIP. Entries named in [stored] are written uncompressed (EPUB needs this for `mimetype`). */
    fun write(out: OutputStream, entries: List<Pair<String, ByteArray>>, stored: Set<String> = emptySet()) {
        val zip = ZipOutputStream(out)
        for ((name, data) in entries) {
            val entry = ZipEntry(name)
            if (name in stored) {
                entry.method = ZipEntry.STORED
                entry.size = data.size.toLong()
                entry.compressedSize = data.size.toLong()
                entry.crc = CRC32().apply { update(data) }.value
            }
            zip.putNextEntry(entry)
            zip.write(data)
            zip.closeEntry()
        }
        zip.finish()
        zip.flush()
    }
}
