# Maintainer: A Akhil <https://github.com/A-Akhil/>

pkgname=antigravity-manager-bin
_pkgname=antigravity-manager
pkgver=0.25.1
pkgrel=1
pkgdesc="A modern, unified desktop manager for LLM accounts, proxies, and AI quotas."
arch=('x86_64')
url="https://github.com/Draculabo/AntigravityManager"
license=('custom:CC-BY-NC-SA-4.0')
depends=('nss' 'alsa-lib' 'gtk3')
provides=("${_pkgname}")
conflicts=("${_pkgname}")
source=("https://github.com/Draculabo/AntigravityManager/releases/download/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")
sha256sums=('89319f2cf0dacc131e26ebed816987e0618d364df27459baedf097996bb9729f')

package() {
  # makepkg automatically extracts the .deb file into data.tar.* and control.tar.*
  # We just need to extract the data archive into our package directory
  tar -xf data.tar.* -C "${pkgdir}"

  # Optionally clean up any lintian files if they exist in the deb
  rm -rf "${pkgdir}/usr/share/lintian"
}
