package com.dotrino.remotedesktop

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

// Small, common view pieces: plain native views, no AppCompat nor Material (cold start and size,
// CONVENCIONES §16.2), with the theme's colours.

fun Context.px(v: Number) = (v.toFloat() * resources.displayMetrics.density).toInt()
fun Context.col(id: Int) = getColor(id)

fun rounded(color: Int, radius: Int, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    cornerRadius = radius.toFloat(); setColor(color)
    if (stroke > 0) setStroke(stroke, strokeColor)
}

fun Context.label(text: String, sp: Float, color: Int = col(R.color.rd_text), bold: Boolean = false) = TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    setTextColor(color)
    if (bold) setTypeface(typeface, Typeface.BOLD)
    setLineSpacing(0f, 1.15f)
}

/** A pill button. `filled` = the main action (accent). */
fun Context.pill(text: String, filled: Boolean = false, onClick: () -> Unit) = TextView(this).apply {
    this.text = text
    gravity = Gravity.CENTER
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    setTypeface(typeface, Typeface.BOLD)
    setTextColor(col(if (filled) R.color.rd_accent_ink else R.color.rd_text))
    background = if (filled) rounded(col(R.color.rd_accent), px(24)) else rounded(col(R.color.rd_surface), px(24), px(1), col(R.color.rd_line))
    setPadding(px(20), px(12), px(20), px(12))
    isClickable = true; isFocusable = true
    setOnClickListener { onClick() }
}

fun Context.card() = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    background = rounded(col(R.color.rd_surface), px(16), px(1), col(R.color.rd_line))
    setPadding(px(16), px(14), px(16), px(14))
}

fun LinearLayout.add(v: View, top: Int = 0, width: Int = ViewGroup.LayoutParams.MATCH_PARENT) =
    addView(v, LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(top) })

/** Per-device UI preferences (the PWA keeps them in localStorage): only the touch mode. */
object Prefs {
    private const val FILE = "remote-desktop"
    private const val TOUCH = "touch"
    fun touchMode(c: Context): DesktopStage.Mode =
        if (c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(TOUCH, null) == "mouse") DesktopStage.Mode.MOUSE else DesktopStage.Mode.PAN
    fun touchMode(c: Context, m: DesktopStage.Mode) =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(TOUCH, if (m == DesktopStage.Mode.MOUSE) "mouse" else "pan").apply()
}
