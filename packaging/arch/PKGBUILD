# Maintainer: A Akhil <https://github.com/A-Akhil/>

pkgname=antigravity-manager-bin
_pkgname=antigravity-manager
pkgver=0.22.0
pkgrel=1
pkgdesc="A modern, unified desktop manager for LLM accounts, proxies, and AI quotas."
arch=('x86_64')
url="https://github.com/Draculabo/AntigravityManager"
license=('custom:CC-BY-NC-SA-4.0')
depends=('nss' 'alsa-lib' 'gtk3')
provides=("${_pkgname}")
conflicts=("${_pkgname}")
source=("https://github.com/Draculabo/AntigravityManager/releases/download/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")
sha256sums=('98434966895b3f4cbd5c58c778163382f40a4a76b5dc24f71a519e395ebe9de8')

package() {
  # makepkg automatically extracts the .deb file into data.tar.* and control.tar.*
  # We just need to extract the data archive into our package directory
  tar -xf data.tar.* -C "${pkgdir}"

  # Optionally clean up any lintian files if they exist in the deb
  rm -rf "${pkgdir}/usr/share/lintian"
}
