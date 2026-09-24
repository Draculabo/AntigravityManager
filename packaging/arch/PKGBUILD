# Maintainer: A Akhil <https://github.com/A-Akhil/>

pkgname=antigravity-manager-bin
_pkgname=antigravity-manager
pkgver=0.21.1
pkgrel=1
pkgdesc="A modern, unified desktop manager for LLM accounts, proxies, and AI quotas."
arch=('x86_64')
url="https://github.com/Draculabo/AntigravityManager"
license=('custom:CC-BY-NC-SA-4.0')
depends=('nss' 'alsa-lib' 'gtk3')
provides=("${_pkgname}")
conflicts=("${_pkgname}")
source=("https://github.com/Draculabo/AntigravityManager/releases/download/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")
sha256sums=('2b1d5fd35612ce503125899fbc313b92073ade9b534028603e4b19a613d21f58')

package() {
  # makepkg automatically extracts the .deb file into data.tar.* and control.tar.*
  # We just need to extract the data archive into our package directory
  tar -xf data.tar.* -C "${pkgdir}"

  # Optionally clean up any lintian files if they exist in the deb
  rm -rf "${pkgdir}/usr/share/lintian"
}
