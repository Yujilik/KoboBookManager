package com.yujilik.kobobookmanager;

/** Naming rule for "Replace the original" (mirrors src/in-place.ts and iOS FolderAccess.kepubName). */
final class InPlace {
    private InPlace() {}

    /** {@code Book.epub} → {@code Book.kepub.epub}; null when the file already is a KEPUB (nothing to replace). */
    static String kepubName(String name) {
        if (name == null || name.isEmpty()) return null;
        if (endsWithIgnoreCase(name, ".kepub.epub")) return null;
        // Compare in place rather than lower-casing: lower-casing can change the length (e.g. "İ").
        return (endsWithIgnoreCase(name, ".epub") ? name.substring(0, name.length() - 5) : name) + ".kepub.epub";
    }

    /** Whether a provider-chosen name still ends in .kepub.epub (needed for the Kobo to treat it as a KEPUB). */
    static boolean isKepubName(String name) { return name != null && endsWithIgnoreCase(name, ".kepub.epub"); }

    private static boolean endsWithIgnoreCase(String value, String suffix) {
        return value.length() >= suffix.length() && value.regionMatches(true, value.length() - suffix.length(), suffix, 0, suffix.length());
    }
}
