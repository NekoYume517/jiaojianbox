package com.jiaojianbox.app

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

/**
 * 中性表面与 Indigo 强调色，原生登录和连接器使用 Material 3 表达。
 */
object JjbTheme {
    private val Green = Color(0xFF4F46E5)
    private val GreenContainer = Color(0xFFEEEDFD)
    private val Ink = Color(0xFF1C1C21)
    private val Surface_ = Color(0xFFF4F4F6)

    fun light(): ColorScheme = lightColorScheme(
        primary = Green,
        onPrimary = Color.White,
        primaryContainer = GreenContainer,
        onPrimaryContainer = Color(0xFF312E81),
        secondary = Color(0xFF456B98),
        background = Surface_,
        surface = Color.White,
        surfaceVariant = Color(0xFFE6E6EB),
        onSurface = Ink,
        onSurfaceVariant = Color(0xFF707079),
        outlineVariant = Color(0xFFE3E3E8),
        error = Color(0xFFA24736),
        errorContainer = Color(0xFFFAEAE6),
    )

    fun dark(): ColorScheme = darkColorScheme(
        primary = Color(0xFFA5B4FC),
        onPrimary = Color(0xFF14142A),
        primaryContainer = Color(0xFF2B2C47),
        onPrimaryContainer = Color(0xFFDBE1FF),
        secondary = Color(0xFFB5D0EC),
        background = Color(0xFF1A1A1E),
        surface = Color(0xFF232327),
        surfaceVariant = Color(0xFF2D2D33),
        onSurface = Color(0xFFEDEDF1),
        onSurfaceVariant = Color(0xFFA1A1AA),
        outlineVariant = Color(0xFF333339),
        error = Color(0xFFEDB5A7),
        errorContainer = Color(0xFF4C302A),
    )
}
