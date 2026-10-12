package com.foliolabs.folio.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.foliolabs.folio.R
import com.foliolabs.folio.convert.Format

@Composable
fun FolioApp(viewModel: ConvertViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }

    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(viewModel::open)
    }
    val saveFile = rememberLauncherForActivityResult(CreateDocument()) { uri ->
        uri?.let(viewModel::saveTo)
    }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            viewModel.messageShown()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                BrandBar()
                Header()
                ConverterCard(
                    state = state,
                    onPick = { pickFile.launch(Format.pickerMimeTypes) },
                    onTarget = viewModel::selectTarget,
                    onConvert = viewModel::convert,
                )
                when (val phase = state.phase) {
                    is Phase.Done -> ResultCard(
                        result = phase.result,
                        onSave = { saveFile.launch(phase.result.displayName to phase.result.format.mimeType) },
                        onShare = { share(context, phase.result) },
                        onOpen = { if (!openWithApp(context, phase.result)) viewModel.showMessage("No app on this phone opens ${phase.result.format.label} files.") },
                    )
                    is Phase.Error -> ErrorCard(phase.message)
                    else -> Unit
                }
                PrivacyNote()
            }
        }
    }
}

@Composable
private fun BrandBar() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(FolioColors.Ink),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(R.drawable.ic_doc), contentDescription = null, tint = FolioColors.Paper, modifier = Modifier.size(18.dp))
        }
        Text("Folio", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
    }
}

@Composable
private fun Header() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "Convert any book.",
            fontSize = 34.sp,
            lineHeight = 36.sp,
            fontWeight = FontWeight.ExtraBold,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            "PDF, EPUB, Word and text, converted right on your phone.",
            fontSize = 17.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ConverterCard(
    state: UiState,
    onPick: () -> Unit,
    onTarget: (Format) -> Unit,
    onConvert: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            val file = state.file
            if (file == null) {
                PickArea(enabled = !state.busy, onPick = onPick)
            } else {
                FileRow(name = file.name, format = file.format, size = file.sizeBytes, enabled = !state.busy, onChange = onPick)
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Convert to", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (format in state.targets) {
                        FilterChip(
                            selected = format == state.target,
                            onClick = { onTarget(format) },
                            enabled = !state.busy,
                            label = { Text(format.label, fontWeight = FontWeight.SemiBold) },
                            shape = RoundedCornerShape(999.dp),
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.secondary,
                                selectedLabelColor = MaterialTheme.colorScheme.onSecondary,
                            ),
                        )
                    }
                }
            }

            val working = state.phase as? Phase.Working
            if (working != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().clip(CircleShape))
                    Text(working.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Button(
                onClick = onConvert,
                enabled = file != null && !state.busy,
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.secondary,
                    contentColor = MaterialTheme.colorScheme.onSecondary,
                ),
            ) {
                Text("Convert to ${state.target.label}", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(8.dp))
                Icon(painterResource(R.drawable.ic_arrow), contentDescription = null, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun PickArea(enabled: Boolean, onPick: () -> Unit) {
    val outline = MaterialTheme.colorScheme.outline
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .drawBehind {
                drawRoundRect(
                    color = outline,
                    style = Stroke(width = 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 10f))),
                    cornerRadius = CornerRadius(16.dp.toPx()),
                )
            }
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "Choose a file", onClick = onPick)
            .padding(vertical = 32.dp, horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(painterResource(R.drawable.ic_upload), contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(36.dp))
        Text("Choose a file", fontWeight = FontWeight.SemiBold, fontSize = 17.sp, color = MaterialTheme.colorScheme.onSurface)
        Text("PDF, EPUB, DOCX or TXT, up to 100 MB", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun FileRow(name: String, format: Format, size: Long, enabled: Boolean, onChange: () -> Unit) {
    val context = LocalContext.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        FormatBadge(format)
        Column(Modifier.weight(1f)) {
            Text(name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
            Text(Formatter.formatShortFileSize(context, size), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onChange, enabled = enabled) { Text("Change") }
    }
}

@Composable
private fun FormatBadge(format: Format) {
    Box(
        modifier = Modifier
            .size(width = 42.dp, height = 52.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.inverseSurface)
            .padding(bottom = 6.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Text(format.label, fontSize = 10.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.inverseOnSurface)
    }
}

@Composable
private fun ResultCard(result: ConvertedFile, onSave: () -> Unit, onShare: () -> Unit, onOpen: () -> Unit) {
    val context = LocalContext.current
    Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(22.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text("Your ${result.format.label} is ready", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                    Text(
                        "${result.displayName} · ${Formatter.formatShortFileSize(context, result.file.length())}",
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onSave, modifier = Modifier.weight(1f).height(48.dp), shape = RoundedCornerShape(999.dp)) {
                    Text("Save", fontWeight = FontWeight.SemiBold)
                }
                OutlinedButton(onClick = onShare, modifier = Modifier.weight(1f).height(48.dp), shape = RoundedCornerShape(999.dp)) {
                    Text("Share", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                }
                TextButton(onClick = onOpen, modifier = Modifier.height(48.dp)) {
                    Text("Open", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun ErrorCard(message: String) {
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            message,
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

@Composable
private fun PrivacyNote() {
    Text(
        "Files are converted on this phone and never uploaded. Folio doesn't remove DRM; it converts DRM-free files only.",
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp),
    )
}

/** "Save as" with a file name and MIME type chosen at launch time. */
private class CreateDocument : ActivityResultContract<Pair<String, String>, android.net.Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>) =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.second)
            .putExtra(Intent.EXTRA_TITLE, input.first)

    override fun parseResult(resultCode: Int, intent: Intent?) = intent?.data
}

private fun contentUri(context: Context, result: ConvertedFile) =
    FileProvider.getUriForFile(context, "${context.packageName}.files", result.file)

private fun share(context: Context, result: ConvertedFile) {
    val send = Intent(Intent.ACTION_SEND)
        .setType(result.format.mimeType)
        .putExtra(Intent.EXTRA_STREAM, contentUri(context, result))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, "Share ${result.displayName}"))
}

private fun openWithApp(context: Context, result: ConvertedFile): Boolean {
    val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(contentUri(context, result), result.format.mimeType)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
        context.startActivity(view)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}
