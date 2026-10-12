package com.foliolabs.folio.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Same palette as the Folio website.
object FolioColors {
    val Ink = Color(0xFF10151F)
    val Paper = Color(0xFFF3F4F0)
    val Accent = Color(0xFF2B4EFF)
    val AccentLight = Color(0xFF8FA3FF)
    val Muted = Color(0xFF4A5260)
    val Line = Color(0xFFD9DCD3)
    val InkRaised = Color(0xFF1B2230)
    val InkLine = Color(0xFF3A4250)
}

private val LightScheme = lightColorScheme(
    primary = FolioColors.Accent,
    onPrimary = Color.White,
    secondary = FolioColors.Ink,
    onSecondary = FolioColors.Paper,
    background = FolioColors.Paper,
    onBackground = FolioColors.Ink,
    surface = Color.White,
    onSurface = FolioColors.Ink,
    surfaceVariant = Color(0xFFF8F9F6),
    onSurfaceVariant = FolioColors.Muted,
    outline = Color(0xFFB9BEB3),
    outlineVariant = FolioColors.Line,
    inverseSurface = FolioColors.Ink,
    inverseOnSurface = FolioColors.Paper,
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFFBE4E2),
    onErrorContainer = Color(0xFF5C1210),
)

private val DarkScheme = darkColorScheme(
    primary = FolioColors.AccentLight,
    onPrimary = FolioColors.Ink,
    secondary = FolioColors.Paper,
    onSecondary = FolioColors.Ink,
    background = FolioColors.Ink,
    onBackground = FolioColors.Paper,
    surface = FolioColors.InkRaised,
    onSurface = FolioColors.Paper,
    surfaceVariant = Color(0xFF232A38),
    onSurfaceVariant = Color(0xFFA9B0BC),
    outline = Color(0xFF5A6273),
    outlineVariant = FolioColors.InkLine,
    inverseSurface = FolioColors.Paper,
    inverseOnSurface = FolioColors.Ink,
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF5C1A15),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Composable
fun FolioTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
}
