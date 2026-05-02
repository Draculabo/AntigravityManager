#!/bin/bash

# Exit on any error
set -e

echo "=========================================="
echo " Antigravity Manager Installer & Updater "
echo "=========================================="

# 1. Detect OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     SYSTEM="Linux";;
    Darwin*)    SYSTEM="Mac";;
    CYGWIN*|MINGW*|MSYS*) SYSTEM="Windows";;
    *)          SYSTEM="Unknown"
esac

echo "Detected OS: $SYSTEM"

if [ "$SYSTEM" == "Unknown" ]; then
    echo "Error: Unsupported operating system ($OS)."
    exit 1
fi

# 2. Get the latest git pull origin version
echo ""
echo "[1/3] Fetching latest version from Git..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Current branch: $CURRENT_BRANCH"
git pull origin "$CURRENT_BRANCH"

# 3. Start building the app for the system
echo ""
echo "[2/3] Building the app..."
echo "Installing Node.js dependencies..."
npm install

MAKE_CMD="npm run make"

if [ "$SYSTEM" == "Linux" ]; then
    if command -v dpkg &> /dev/null; then
        MAKE_CMD="npm run make -- --targets @electron-forge/maker-deb"
    elif command -v rpm &> /dev/null; then
        MAKE_CMD="npm run make -- --targets @electron-forge/maker-rpm"
    else
        MAKE_CMD="npm run make -- --targets @electron-forge/maker-zip"
    fi
elif [ "$SYSTEM" == "Windows" ]; then
    MAKE_CMD="npm run make -- --targets @electron-forge/maker-squirrel"
elif [ "$SYSTEM" == "Mac" ]; then
    MAKE_CMD="npm run make -- --targets @electron-forge/maker-dmg"
fi

echo "Running build process ($MAKE_CMD)..."
eval $MAKE_CMD
# 4. Install or update the app
echo ""
echo "[3/3] Installing/Updating the app..."

if [ "$SYSTEM" == "Linux" ]; then
    if command -v dpkg &> /dev/null; then
        echo "Debian/Ubuntu-based system detected."
        DEB_FILE=$(find out/make/deb -name "*.deb" | head -n 1)
        if [ -n "$DEB_FILE" ]; then
            echo "Installing $DEB_FILE..."
            sudo dpkg -i "$DEB_FILE"
            echo "Installation complete."
        else
            echo "Error: Could not find .deb file in out/make/deb/"
            exit 1
        fi
    elif command -v rpm &> /dev/null; then
        echo "RedHat/Fedora-based system detected."
        RPM_FILE=$(find out/make/rpm -name "*.rpm" | head -n 1)
        if [ -n "$RPM_FILE" ]; then
            echo "Installing $RPM_FILE..."
            sudo rpm -Uvh "$RPM_FILE"
            echo "Installation complete."
        else
            echo "Error: Could not find .rpm file in out/make/rpm/"
            exit 1
        fi
    else
        echo "Error: Neither dpkg nor rpm found. Cannot install automatically on this Linux distribution."
        echo "Please check the 'out/make' directory for built packages."
        exit 1
    fi

elif [ "$SYSTEM" == "Windows" ]; then
    echo "Windows system detected."
    EXE_FILE=$(find out/make/squirrel.windows -name "*Setup.exe" | head -n 1)
    if [ -n "$EXE_FILE" ]; then
        echo "Running installer $EXE_FILE..."
        # Convert path to Windows format if cygpath is available (Git Bash / MSYS)
        if command -v cygpath &> /dev/null; then
            WIN_PATH=$(cygpath -w "$EXE_FILE")
            cmd.exe /c start "" "$WIN_PATH"
        else
            cmd.exe /c start "" "$EXE_FILE"
        fi
        echo "Installer launched. Please follow the prompts to complete installation."
    else
        echo "Error: Could not find Setup.exe file in out/make/squirrel.windows/"
        exit 1
    fi

elif [ "$SYSTEM" == "Mac" ]; then
    echo "Mac OS detected."
    # Try finding DMG or Zip
    APP_ZIP=$(find out/make/zip/darwin -name "*.zip" | head -n 1)
    DMG_FILE=$(find out/make -name "*.dmg" | head -n 1)

    if [ -n "$DMG_FILE" ]; then
        echo "Installing from DMG: $DMG_FILE..."
        # Mount DMG
        VOLUME_PATH=$(hdiutil attach "$DMG_FILE" | grep Volumes | awk -F '\t' '{print $3}')
        echo "Mounted at $VOLUME_PATH"
        APP_SRC=$(find "$VOLUME_PATH" -maxdepth 1 -name "*.app" | head -n 1)
        if [ -n "$APP_SRC" ]; then
            APP_NAME=$(basename "$APP_SRC")
            echo "Copying $APP_NAME to /Applications/ (updating if exists)..."
            # Remove existing app if it exists to perform a clean update
            if [ -d "/Applications/$APP_NAME" ]; then
                rm -rf "/Applications/$APP_NAME"
            fi
            cp -R "$APP_SRC" /Applications/
            echo "Installation complete. Unmounting DMG..."
        else
            echo "Error: Could not find .app inside the DMG."
        fi
        hdiutil detach "$VOLUME_PATH"
    elif [ -n "$APP_ZIP" ]; then
        echo "Extracting app from ZIP: $APP_ZIP..."
        unzip -o "$APP_ZIP" -d /Applications/
        echo "Installation complete."
    else
        echo "Error: Could not find DMG or ZIP file in out/make/"
        exit 1
    fi
fi

echo ""
echo "=========================================="
echo " All tasks completed successfully!"
echo "=========================================="
