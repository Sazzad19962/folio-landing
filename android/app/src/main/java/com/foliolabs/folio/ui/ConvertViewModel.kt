package com.foliolabs.folio.ui

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.foliolabs.folio.convert.ConversionException
import com.foliolabs.folio.convert.Converter
import com.foliolabs.folio.convert.Format
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/** A file the user picked, read fully into memory so its URI permission can lapse. */
class PickedFile(val name: String, val format: Format, val bytes: ByteArray) {
    val baseName: String get() = name.substringBeforeLast('.').ifBlank { "document" }
    val sizeBytes: Long get() = bytes.size.toLong()
}

data class ConvertedFile(val file: File, val format: Format) {
    val displayName: String get() = file.name
}

sealed interface Phase {
    data object Idle : Phase
    data class Working(val message: String) : Phase
    data class Done(val result: ConvertedFile) : Phase
    data class Error(val message: String) : Phase
}

data class UiState(
    val file: PickedFile? = null,
    val target: Format = Format.EPUB,
    val phase: Phase = Phase.Idle,
    val message: String? = null,
) {
    val targets: List<Format> get() = Format.entries.filter { it != file?.format }
    val busy: Boolean get() = phase is Phase.Working
}

class ConvertViewModel(application: Application) : AndroidViewModel(application) {
    private val converter = Converter(application)
    private val outputDir = File(application.cacheDir, "converted")

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun open(uri: Uri) {
        viewModelScope.launch {
            _state.update { it.copy(phase = Phase.Working("Opening file…")) }
            try {
                val picked = withContext(Dispatchers.IO) { load(uri) }
                _state.update {
                    UiState(file = picked, target = Format.defaultTargetFor(picked.format))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConversionException) {
                _state.update { it.copy(phase = Phase.Error(e.message.orEmpty())) }
            } catch (e: Exception) {
                _state.update { it.copy(phase = Phase.Error("Couldn't open this file.")) }
            }
        }
    }

    fun selectTarget(format: Format) {
        _state.update { it.copy(target = format, phase = if (it.busy) it.phase else Phase.Idle) }
    }

    fun convert() {
        val current = _state.value
        val file = current.file ?: return
        if (current.busy) return
        val target = current.target
        viewModelScope.launch {
            _state.update { it.copy(phase = Phase.Working("Reading ${file.format.label}…")) }
            try {
                val result = withContext(Dispatchers.IO) {
                    val book = converter.read(file.bytes, file.format, file.baseName)
                    _state.update { it.copy(phase = Phase.Working("Writing ${target.label}…")) }
                    outputDir.deleteRecursively()
                    outputDir.mkdirs()
                    val out = File(outputDir, "${safeName(file.baseName)}.${target.extension}")
                    out.outputStream().buffered().use { converter.write(book, target, it) }
                    ConvertedFile(out, target)
                }
                _state.update { it.copy(phase = Phase.Done(result)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConversionException) {
                _state.update { it.copy(phase = Phase.Error(e.message.orEmpty())) }
            } catch (e: OutOfMemoryError) {
                _state.update { it.copy(phase = Phase.Error("This file is too large to convert on this phone.")) }
            } catch (e: Exception) {
                _state.update { it.copy(phase = Phase.Error("Conversion failed: ${e.message ?: e.javaClass.simpleName}")) }
            }
        }
    }

    fun saveTo(uri: Uri) {
        val result = (_state.value.phase as? Phase.Done)?.result ?: return
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { out ->
                        result.file.inputStream().use { it.copyTo(out) }
                    } ?: error("no stream")
                }.isSuccess
            }
            showMessage(if (ok) "Saved ${result.displayName}" else "Couldn't save the file.")
        }
    }

    fun showMessage(text: String) = _state.update { it.copy(message = text) }

    fun messageShown() = _state.update { it.copy(message = null) }

    private fun load(uri: Uri): PickedFile {
        val resolver = getApplication<Application>().contentResolver
        var name: String? = null
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val nameIndex = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = c.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = c.getString(nameIndex)
                if (sizeIndex >= 0 && !c.isNull(sizeIndex)) size = c.getLong(sizeIndex)
            }
        }
        val displayName = name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "document"
        val format = Format.fromFileName(displayName)
            ?: Format.fromMimeType(resolver.getType(uri))
            ?: throw ConversionException(unsupported(displayName))
        if (size > MAX_BYTES) throw ConversionException("This file is over 100 MB. Folio converts files up to 100 MB.")
        val bytes = resolver.openInputStream(uri)?.use(::readCapped)
            ?: throw ConversionException("Couldn't open this file.")
        return PickedFile(displayName, format, bytes)
    }

    private fun readCapped(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            total += n
            if (total > MAX_BYTES) throw ConversionException("This file is over 100 MB. Folio converts files up to 100 MB.")
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private fun unsupported(name: String): String {
        val ext = name.substringAfterLast('.', "").uppercase()
        return if (ext in setOf("MOBI", "AZW", "AZW3", "DOC", "CBZ", "RTF", "ODT")) {
            "$ext files aren't supported yet. Folio converts PDF, EPUB, DOCX and TXT."
        } else {
            "Folio can't read this file type. Choose a PDF, EPUB, DOCX or TXT file."
        }
    }

    private fun safeName(name: String) = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)

    private companion object {
        const val MAX_BYTES = 100L * 1024 * 1024
    }
}
