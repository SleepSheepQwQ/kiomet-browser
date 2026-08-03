#!/bin/sh
# Gradle wrapper — delegates to the downloaded distribution
set -e

GRADLE_USER_HOME=${GRADLE_USER_HOME:-"$HOME/.gradle"}
APP_NAME="gradle"
APP_BASE_NAME=`basename "$0"`
APP_HOME=`cd "$HOME"`
APP_HOME=`cd "$(dirname "$0")/.." && pwd`

if [ ! -r "$APP_HOME/gradle/wrapper/gradle-wrapper.properties" ]; then
    echo "gradle-wrapper.properties not found"
    exit 1
fi

# Parse gradle-wrapper.properties
gradleHome="$APP_HOME/gradle/wrapper"
distributionUrl=`grep distributionUrl "$gradleHome/gradle-wrapper.properties" | cut -d'=' -f2`
distributionUrl=${distributionUrl#https\://}

gradleDistribution="$GRADLE_USER_HOME/wrapper/dists/gradle-8.7-bin"
gradleDistribution="$gradleDistribution/gradle-8.7"

if [ ! -d "$gradleDistribution" ]; then
    mkdir -p "$GRADLE_USER_HOME/wrapper/dists"
    echo "Downloading gradle..."
    curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-8.7-bin.zip"
    mkdir -p "$gradleDistribution.tmp"
    unzip -q /tmp/gradle.zip -d "$gradleDistribution.tmp"
    mv "$gradleDistribution.tmp/gradle-8.7" "$gradleDistribution"
    rm -rf "$gradleDistribution.tmp" /tmp/gradle.zip
fi

exec "$gradleDistribution/bin/gradle" "$@"
