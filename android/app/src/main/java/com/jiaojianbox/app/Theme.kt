package com.jiaojianbox.app

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

/**
 * 与桌面/网页同一套绿色体系（--green #2b634a 等），Material 3 表达。
 */
object JjbTheme {
    private val Green = Color(0xFF2B634A)
    private val GreenContainer = Color(0xFFE8F3E7)
    private val Ink = Color(0xFF26372D)
    private val Surface_ = Color(0xFFF5F7F3)

    fun light(): ColorScheme = lightColorScheme(
        primary = Green,
        onPrimary = Color.White,
        primaryContainer = GreenContainer,
        onPrimaryContainer = Color(0xFF346A3F),
        secondary = Color(0xFF456B98),
        background = Surface_,
        surface = Color.White,
        surfaceVariant = Color(0xFFE9EEE4),
        onSurface = Ink,
        onSurfaceVariant = Color(0xFF697B6C),
        outlineVariant = Color(0xFFDFE7D9),
        error = Color(0xFFA24736),
        errorContainer = Color(0xFFFAEAE6),
    )

    fun dark(): ColorScheme = darkColorScheme(
        primary = Color(0xFFA0D4AD),
        onPrimary = Color(0xFF162E1D),
        primaryContainer = Color(0xFF294932),
        onPrimaryContainer = Color(0xFFB0DAB6),
        secondary = Color(0xFFB5D0EC),
        background = Color(0xFF101914),
        surface = Color(0xFF19251E),
        surfaceVariant = Color(0xFF26382B),
        onSurface = Color(0xFFE2EBE3),
        onSurfaceVariant = Color(0xFFA3B5A4),
        outlineVariant = Color(0xFF344737),
        error = Color(0xFFEDB5A7),
        errorContainer = Color(0xFF4C302A),
    )
}
