pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "remote-desktop"
include(":app")
// La librería nativa del ecosistema (perfil, transporte, agente remoto, barra): el repo
// dotrino-native. CONVENCIONES §16.2: nada de eso se reimplementa en la app.
// Como en Terminal, lo normal es el submódulo en ../native; mientras este repo no lo tenga, se
// usa la copia hermana del ecosistema (../../dotrino-native). `-PdotrinoNative=<ruta>` la fija.
val nativeDir = providers.gradleProperty("dotrinoNative").orNull
    ?: listOf("../native/android", "../../dotrino-native/android").firstOrNull { file(it).resolve("settings.gradle.kts").exists() }
    ?: error("dotrino-native not found: add it as the submodule ../native, or pass -PdotrinoNative=<path to dotrino-native/android>")
includeBuild(nativeDir)
