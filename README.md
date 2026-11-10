# Compu-Cart Game Sync

Crée une application windows pour un système nommé "Compu-Cart". L'application doit gérer l'automatisation au branchement d'un support de stockage externe (cartouche de jeu) : 1. Un module de détection d'événements matériels (hotplug) et de vérification d'intégrité. 2. Un gestionnaire de synchronisation de sauvegardes (Savegame Sync Engine) bi-directionnel qui compare les horodatages entre le stockage local et la cartouche, gère la création automatique des chemins d'accès utilisateur, et effectue une copie sécurisée. 3. Un orchestrateur qui déclenche une séquence d'introduction (splash screen / jingle) avant de lancer le jeu cibler présent sur la cartouche.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/9eb998cb-6598-52d5-a1ea-3a8a1a0e8cb0).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
