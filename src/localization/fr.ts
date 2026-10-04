import en from './en';
const fr = {
  'agent-tools': {
    title: 'Connecter vos outils de programmation',
    description: 'Choisissez un outil pour utiliser vos modèles via Antigravity Manager.',
    loading: 'Lecture des paramètres…',
    installed: 'Installé',
    'not-installed': 'Installation non détectée',
    'read-error': 'Impossible de lire les paramètres. Réessayez avant de les modifier.',
    retry: 'Réessayer',
    configured: 'Configuration enregistrée',
    'custom-address': 'Autre adresse utilisée',
    'not-configured': 'Non configuré',
    'not-verified': 'Requêtes non vérifiées',
    address: 'Adresse de Manager',
    model: 'Modèle',
    'not-set': 'Non défini',
    'choose-model': 'Choisir pendant la configuration',
    update: 'Mettre à jour',
    configure: 'Configurer',
    view: 'Voir la configuration',
    restore: 'Restaurer la sauvegarde',
    remove: 'Retirer la connexion',
    'install-notice': 'Vous pouvez configurer l’outil avant son installation. Rouvrez-le ensuite.',
    'action-error': 'Échec de la mise à jour',
    saved: 'Paramètres mis à jour',
    reopen: 'Rouvrez {{name}} pour appliquer les paramètres.',
    'configure-title': 'Connecter {{name}}',
    'configure-description':
      'Les requêtes utiliseront Manager. Les paramètres sont sauvegardés avant la première modification.',
    'restore-title': 'Restaurer les paramètres de {{name}} ?',
    'restore-description':
      'Le fichier entier sera remplacé par sa sauvegarde initiale, y compris les modifications ultérieures. Si Manager a créé le fichier, il sera supprimé. La sauvegarde est utilisée une seule fois.',
    'remove-title': 'Retirer la connexion à Manager ?',
    'remove-description':
      'Restaure les anciens paramètres de connexion en conservant les autres paramètres et la sauvegarde.',
    'preview-title': 'Paramètres de {{name}}',
    'preview-description':
      'Seuls les réglages nécessaires pour se connecter à Manager sont affichés. Les clés de connexion sont masquées.',
    confirm: 'Confirmer',
    advanced: 'Adresse et fichier de configuration',
    'reset-address': 'Utiliser l’adresse actuelle de Manager',
    'backend-files':
      'Ces réglages sont enregistrés sur l’ordinateur qui exécute le service Manager, pour l’utilisateur qui le lance.',
    'backup-notice':
      'La première sauvegarde est conservée après les mises à jour. Rouvrez l’outil après l’enregistrement.',
    'toml-notice':
      'La mise en forme et les commentaires du fichier Codex peuvent changer. Une sauvegarde complète permet de les restaurer. La connexion et les autorisations existantes sont conservées.',
    'codex-review':
      'Configure les requêtes de tâche et de vérification automatique. Les routes de vérification actives et les paramètres d’approbation existants sont conservés.',
    'model-count': '{{count}} modèle(s)',
    'plugin-notice':
      'Un plugin de connexion directe est installé. Vérifiez que Manager est sélectionné dans OpenCode.',
    'revoke-key': 'Désactiver la clé de connexion OpenCode',
    errors: {
      unavailable: 'Les paramètres sont indisponibles. Réessayez.',
      'invalid-config':
        'Le fichier est invalide ou trop volumineux. Corrigez-le avant la configuration.',
      'read-failed': 'Impossible de lire le fichier. Vérifiez les permissions.',
      'write-failed': 'Échec de l’enregistrement. La sauvegarde est conservée.',
      'backup-failed':
        'Impossible de créer la sauvegarde. Les paramètres de l’outil ne sont pas modifiés.',
      'backup-missing': 'Aucune sauvegarde disponible.',
      'configuration-changed':
        'Les paramètres ont changé pendant l’opération. Relisez-les et réessayez.',
      'key-missing': 'Créez d’abord une clé sur la page du proxy.',
      'review-route-disabled':
        'La route de vérification Codex est désactivée. Activez-la dans le routage des modèles.',
    },
  },
  appName: 'Antigravity Manager',
  'process-runtime': {
    'close-failed':
      'Impossible de fermer Antigravity. Enregistrez vos conversations et fichiers, fermez l’application manuellement, puis réessayez.',
    'exit-unconfirmed':
      'Antigravity n’a pas terminé sa fermeture. Enregistrez vos conversations et fichiers, fermez l’application manuellement, puis réessayez.',
    working: 'Traitement...',
    busy: 'Antigravity est occupé. Attendez la fin de l’opération.',
    'missing-executable':
      'Antigravity est introuvable ou ne peut pas être ouvert. Vérifiez son emplacement dans les paramètres.',
    'target-conflict':
      'L’application Antigravity ouverte ne correspond pas à l’installation sélectionnée. Fermez-la ou sélectionnez la bonne installation avant de changer de compte.',
    'directory-conflict':
      'Antigravity utilise un autre dossier de données que celui sélectionné. Fermez-le ou vérifiez le dossier dans les paramètres avant de changer de compte.',
    'probe-failed':
      'Impossible de vérifier à temps l’état d’Antigravity. Vérifiez si l’application est ouverte et réessayez.',
    'launch-failed':
      'Impossible d’ouvrir Antigravity. Vérifiez son emplacement et les autorisations d’accès.',
    'startup-unconfirmed':
      'L’ouverture d’Antigravity n’a pas encore été confirmée. Aucun second lancement n’a été tenté. Vérifiez l’application avant de réessayer.',
    'switched-hot-unconfirmed':
      'Le nouveau compte est enregistré, mais le changement dans Antigravity IDE n’a pas été confirmé. Vérifiez le compte affiché avant de réessayer.',
    'switched-startup-unconfirmed':
      'Le nouveau compte est enregistré, mais l’ouverture d’Antigravity n’a pas été confirmée. Aucun second lancement n’a été tenté. Vérifiez l’application avant de réessayer.',
  },
  common: {
    'core-unavailable-title': 'Connexion à Antigravity Manager impossible',
    'core-unavailable-body':
      'Les comptes et le proxy sont momentanément indisponibles. Fermez puis rouvrez Antigravity Manager. Si le problème persiste, installez la dernière version.',
    'account-data-unavailable-title': 'Impossible d’ouvrir les comptes enregistrés',
    'account-data-unavailable-body':
      'Les comptes enregistrés ne peuvent pas être lus pour le moment. Vérifiez que vous utilisez votre compte habituel sur cet ordinateur, puis rouvrez Antigravity Manager. Vos données de compte n’ont pas été modifiées.',
    'already-running-title': 'Antigravity Manager est déjà ouvert',
    'already-running-body':
      'Fermez l’autre fenêtre d’Antigravity Manager, puis réessayez. Si vous ne la trouvez pas, redémarrez l’ordinateur.',
    loading: 'Chargement...',
    error: 'Erreur',
    unknown: 'Inconnu',
    notAvailable: 'N/A',
    openMenu: 'Ouvrir le menu',
  },
  status: {
    checking: 'Verification du statut...',
    running: 'Antigravity fonctionne en arriere-plan',
    stopped: 'Service Antigravity arrete',
    services: 'Services',
    dashboard_title: 'Statut des services',
    open_dashboard: 'Ouvrir le statut des services',
    checking_short: 'Verification...',
    running_short: 'En cours',
    stopped_short: 'Arrete',
    all_running: 'Tous les services fonctionnent',
    all_stopped: 'Tous les services sont arretes',
    partial_running: '{{running}}/{{total}} services fonctionnent',
  },
  action: {
    stop: 'Arreter',
    start: 'Demarrer',
    switch: 'Basculer',
    deleteBackup: 'Supprimer la sauvegarde',
    backupCurrent: 'Sauvegarder le compte actuel',
    retry: 'Reessayer',
    details: 'Details',
    openLogs: 'Ouvrir le dossier des journaux',
  },
  update: {
    title: 'Mises a jour',
    checking: 'Verification...',
    checkNow: 'Rechercher des mises a jour',
    checkFailed: 'Impossible de rechercher des mises a jour',
    upToDate: 'Vous etes a jour.',
    unsupported:
      'La recherche automatique de mises a jour n est pas disponible sur cette plateforme.',
    available: {
      title: 'Mise a jour disponible',
      description: 'La version {{version}} est disponible sur GitHub.',
      download: 'Telecharger',
      downloading: 'Telechargement...',
      dismiss: 'Ignorer',
      macosUnsignedNote:
        'Cette version macOS n est pas officiellement signee. Si macOS bloque l app, suivez les etapes de signature manuelle dans le README GitHub ou les issues associees.',
    },
    downloaded: {
      title: 'Mise a jour prete',
      description: 'La version {{version}} a ete telechargee.',
      restart: 'Redemarrer',
    },
  },
  error: {
    generic: 'Une erreur inattendue s est produite.',
    detailsTitle: 'Details de l erreur',
    detailsDescription:
      'Ces détails peuvent aider à résoudre le problème et contenir des emplacements de fichiers personnels. Vérifiez-les avant de les partager.',
    keychainUnavailable:
      'Impossible de lire les informations de connexion enregistrées pour le moment.',
    keychainHint: {
      translocation: 'Déplacez l’application dans le dossier Applications, puis rouvrez-la.',
      keychainDenied:
        'macOS a bloqué l’accès aux informations de connexion enregistrées. Consultez les instructions d’installation de l’application, puis réessayez.',
      signNotarize: 'Si possible, installez une version reconnue comme vérifiée par macOS.',
    },
    dataMigrationFailed: 'Impossible de lire les comptes enregistrés par une ancienne version.',
    masterKeyUnavailable:
      'Des comptes enregistrés ont été trouvés, mais ils ne peuvent pas être ouverts pour le moment. Vos données de compte n’ont pas été modifiées.',
    dataMigrationHint: {
      relogin: 'Reconnectez-vous ou ajoutez de nouveau vos comptes.',
      clearData:
        'Si le probleme persiste, effacez les donnees de compte locales et reconnectez-vous.',
    },
    antigravityStorageJsonNotFound:
      'La configuration initiale d’Antigravity est incomplète. Ouvrez l’application sélectionnée et connectez-vous une fois, puis réessayez de changer de compte.',
    antigravityProjectIdMissing:
      'Ce compte n’est pas encore prêt pour Antigravity. Connectez-vous avec ce compte dans Antigravity une fois, puis réessayez.',
    antigravityDatabasePermissionDenied:
      'Impossible d’enregistrer la connexion Antigravity. Vérifiez que son dossier de données peut être modifié, ou ouvrez Antigravity une fois puis redémarrez Manager.',
    cloudAccountLoginExpired:
      'Les informations de connexion de ce compte cloud ont expire. Veuillez vous reconnecter.',
  },
  nav: {
    accounts: 'Comptes',
    proxy: 'Proxy API',
    settings: 'Parametres',
    traffic: 'Trafic',
  },
  traffic: {
    ...en.traffic,
    'search-metadata': 'Rechercher un modèle, un numéro de requête ou une adresse',
    'copy-upstream-curl':
      'Copier la requête au service de modèles en cURL (données privées masquées)',
    'upstream-attempts': 'Requêtes envoyées au service de modèles',
    'no-attempts': 'Aucune requête n’a été envoyée au service de modèles.',
    upstream: 'Service de modèles',
    endpoint: 'Adresse du service',
    protocol: 'Format API',
    'repair-databases': 'Réparer les données enregistrées',
    'concise-help':
      'Afficher les informations principales. Les sections développées restent affichées en entier.',
    'full-help':
      'Afficher toutes les informations chargées. Si le contenu ne peut pas être organisé ou est incomplet, les deux vues peuvent être identiques.',
    'load-next-window': 'Section suivante',
    offset: 'Position dans le contenu : {{offset}}',
    'parse-error': 'Impossible de lire ce contenu à la position {{offset}}.',
    'thought-oversized':
      'Le raisonnement dépasse 64 MiB et n’a pas été enregistré en entier. Référence : {{hash}}',
  },
  editionSelection: {
    title: 'Choisissez votre edition Antigravity',
    description:
      'Selectionnez la version d Antigravity que vous utilisez. Cela aide le Manager a se connecter a la bonne application.',
    edition1x: {
      name: 'Antigravity 1.x',
      description:
        'L application Antigravity originale. Choisissez ceci si vous utilisez l ancienne version.',
    },
    edition20: {
      name: 'Antigravity IDE',
      description:
        'Le nouvel Antigravity IDE (2.0). Choisissez ceci si vous utilisez la derniere version IDE.',
    },
    confirm: 'Continuer',
  },
  account: {
    current: 'Actuel',
    lastUsed: 'Derniere utilisation {{time}}',
    switchToAntigravity: 'Basculer vers Antigravity',
    switchToIde: 'Basculer vers Antigravity IDE',
  },
  home: {
    title: 'Comptes',
    description: 'Gerez vos comptes Google Gemini Antigravity.',
    noBackups: {
      title: 'Aucune sauvegarde trouvee',
      description: 'Creez une sauvegarde de votre compte Antigravity actuel pour commencer.',
      action: 'Sauvegarder le compte actuel',
    },
  },
  settings: {
    'service-unavailable':
      'Impossible d’ouvrir ou d’enregistrer les paramètres pour le moment. Réessayez. Si le problème persiste, fermez puis rouvrez Antigravity Manager.',
    'service-retry': 'Réessayer',
    'service-restart-required':
      'Paramètres enregistrés. Désactivez puis réactivez le proxy pour appliquer les modifications.',
    'service-save': 'Enregistrer',
    'service-secret-configured':
      'Une adresse proxy est déjà définie. Saisissez-en une autre pour la remplacer.',
    'weekly-warmup': {
      error: 'Impossible de charger ou enregistrer les paramètres.',
      retry: 'Réessayer',
      'cost-notice':
        'Le préchauffage consomme du quota et peut utiliser des crédits IA. Une réponse HTTP acceptée ne garantit pas un nouveau cycle hebdomadaire.',
      title: 'Préchauffage du quota hebdomadaire',
      description:
        'Après la réinitialisation d’un quota sélectionné, envoie une requête minimale par compartiment et mémorise les cycles réussis.',
      enabled: 'Activer le préchauffage hebdomadaire',
      groups: 'Groupes de quotas à préchauffer',
      group: { claude: 'Groupes de quotas Claude', gemini: 'Groupes de quotas Gemini' },
    },
    title: 'Parametres',
    description: 'Gerez les preferences de l application.',
    general: 'General',
    connection: 'Connexion',
    models: 'Modeles',
    appearance: {
      title: 'Apparence',
      description: 'Personnalisez l apparence d Antigravity Manager sur votre appareil.',
    },
    darkMode: 'Mode sombre',
    darkModeDescription: 'Activez le mode sombre pour un meilleur confort la nuit.',
    language: {
      title: 'Langue',
      description: 'Selectionnez votre langue preferee.',
      english: 'Anglais',
      chinese: 'Chinois (simplifie)',
      russian: 'Russe',
      vietnamese: 'Vietnamien',
      turkish: 'Turc',
      french: 'Français',
    },
    about: {
      title: 'A propos',
      description: 'Informations sur l application.',
    },
    cache: {
      title: 'Cache Antigravity',
      description:
        'Effacez les dossiers de cache connus d Antigravity et d Antigravity IDE pour résoudre les problèmes de connexion ou de validation de version.',
      clear: 'Effacer le cache Antigravity',
      dialogTitle: 'Effacer le cache Antigravity ?',
      dialogDescription: 'Les dossiers de cache existants suivants seront supprimés.',
      pathsLabel: 'Dossiers de cache',
      noPaths: 'Aucun dossier de cache Antigravity connu n a été trouvé.',
      warning: 'Fermez Antigravity avant le nettoyage afin d éviter les fichiers verrouillés.',
      cancel: 'Annuler',
      confirm: 'Effacer le cache',
      clearing: 'Nettoyage...',
      clearedTitle: 'Cache effacé',
      clearedDescription: '{{size}} Mo ont été supprimés des dossiers de cache Antigravity.',
      failedTitle: 'Échec du nettoyage du cache',
      notFoundTitle: 'Aucun cache Antigravity trouvé',
    },
    version: 'Version',
    platform: 'Plateforme',
    license: 'Licence',
    openLogDir: 'Ouvrir',
    toast: {
      saved: {
        title: 'Parametres enregistres',
        description: 'Votre configuration a ete mise a jour.',
      },
      saveFailed: {
        title: 'Erreur lors de l enregistrement des parametres',
      },
    },
    account: {
      title: 'Parametres du compte',
      description: 'Configurez l actualisation et la synchronisation automatiques des comptes.',
      auto_refresh: 'Actualisation automatique du quota',
      auto_refresh_desc: 'Actualiser regulierement les informations de quota de tous les comptes',
      auto_sync: 'Synchronisation automatique du compte actuel',
      auto_sync_desc: 'Synchroniser regulierement les informations du compte actif',
      antigravity_executable: 'Executable Antigravity',
      antigravity_executable_desc:
        'Chemin facultatif utilise pour trouver les donnees du mode portable et lancer Antigravity.',
      antigravity_executable_placeholder:
        'Exemple : C:\\Program Files\\Antigravity\\Antigravity.exe',
      antigravity_cli_executable: 'Exécutable Antigravity CLI',
      antigravity_cli_executable_desc:
        'Chemin vers le CLI agy. Le correctif d’éligibilité est limité à ce fichier.',
      antigravity_cli_executable_placeholder: 'Exemple : C:\\Program Files\\Antigravity\\agy.exe',
      detect_antigravity_cli: 'Détecter',
      agy_cli_detected: 'CLI Antigravity détecté',
      agy_cli_detect_failed: 'CLI Antigravity introuvable',
      agy_patch_desc:
        'Sauvegarde le CLI, vérifie un motif ARM64 ou x86_64 unique, applique le correctif et signe à nouveau les fichiers Mach-O sur macOS.',
      agy_patch_action: 'Appliquer le correctif d’éligibilité',
      agy_patch_success: 'Antigravity CLI corrigé',
      agy_patch_already_applied: 'Correctif déjà appliqué',
      agy_patch_failed: 'Impossible de corriger Antigravity CLI',
      agy_patch_result:
        'Format : {{format}} ; architectures : {{architectures}} ; sauvegarde : {{backupPath}}',
      agy_patch_no_backup: 'non requise',
      antigravity_ide_executable: 'Executable Antigravity IDE',
      antigravity_ide_executable_desc:
        'Chemin facultatif de l executable Antigravity IDE. Lors du basculement de comptes Classic, les processus a ce chemin sont proteges contre l arret.',
      antigravity_ide_executable_placeholder:
        'Exemple : C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
      antigravity_args: 'Arguments de lancement Antigravity',
      antigravity_args_desc:
        'Arguments facultatifs transmis au lancement d Antigravity, comme --user-data-dir.',
      antigravity_args_placeholder: 'Exemple : --user-data-dir D:\\AntigravityProfile',
      antigravity_ide_args: 'Arguments de lancement Antigravity IDE',
      antigravity_ide_args_desc:
        'Arguments facultatifs transmis au lancement d Antigravity IDE, comme --user-data-dir.',
      antigravity_ide_args_placeholder: 'Exemple : --user-data-dir D:\\AntigravityIdeProfile',
      detect_antigravity_args: 'Detecter',
    },
    startup: {
      title: 'Demarrage',
      description: 'Controlez le comportement de lancement au demarrage du systeme.',
      auto_startup: 'Demarrer avec le systeme',
      auto_startup_desc: 'Lancer a la connexion et garder l app dans la zone de notification',
      start_in_tray: 'Demarrer dans la zone de notification',
      start_in_tray_desc: "Demarrer l'application reduite dans la zone de notification",
      macos_hint:
        'macOS exige une app signee pour que les elements de connexion fonctionnent. Si le demarrage automatique echoue, signez l app ou activez-la manuellement dans les reglages systeme.',
    },
    privacy: {
      title: 'Confidentialite',
      description: 'Controlez l utilisation de vos donnees pour ameliorer l application.',
      error_reporting: 'Rapports d erreur',
      error_reporting_desc:
        'Envoyer des rapports d erreur anonymes pour nous aider a ameliorer l app. Aucune donnee personnelle n est collectee.',
      telemetry: 'Telemetrie de performance',
      telemetry_desc:
        'Partager des metriques et traces anonymes pour diagnostiquer les basculements de compte lents.',
      clarity: 'Microsoft Clarity',
      clarity_desc:
        'Partager des diagnostics d interaction anonymes, des heatmaps et des relectures de session pour ameliorer l app.',
      clarity_unavailable: 'Microsoft Clarity n est pas configure pour cette build.',
      restart_note:
        'Certains réglages de journaux et de diagnostic prennent effet après le redémarrage.',
    },
    notifications: {
      title: 'Notifications',
      description: 'Configurez les alertes de bureau pour les evenements de compte.',
      quotaAlert: 'Alertes de quota faible',
      quotaAlertDesc:
        'Recevoir une notification quand le quota d un modele passe sous le seuil defini',
      quotaThreshold: 'Seuil d alerte',
      quotaThresholdDesc: 'Pourcentage en dessous duquel declencher une alerte',
      saveFailed: 'Echec de l enregistrement des parametres de notification',
      thresholdSaveFailed: 'Echec de l enregistrement du seuil',
      aiCreditsAlert: 'Alerte de credits IA faibles',
      aiCreditsAlertDesc:
        'Recevoir une notification quand le solde de credits IA atteint ou passe sous le seuil defini',
      aiCreditsThreshold: 'Seuil d alerte de credits IA',
      aiCreditsThresholdDesc: 'Montant de credits en dessous ou egal auquel declencher une alerte',
      aiCreditsThresholdSaveFailed: 'Echec de l enregistrement du seuil de credits IA',
    },
    proxy: {
      title: 'Proxy amont',
      description: 'Configurez un proxy pour les requetes sortantes vers les API Google/Gemini.',
      enable: 'Activer le proxy amont',
      url: 'URL du proxy',
      timeout: 'Delai de requete (secondes)',
    },
    modelMapping: {
      title: 'Mappage des modeles',
      description:
        'Mappez les modeles Claude Code vers les modeles Antigravity. Optimisez cout et vitesse en routant les requetes intelligemment.',
      claudeKeyword: 'Modele Claude (mot-cle)',
      targetGemini: 'Modele Gemini cible',
      addPlaceholderKey: 'ex. op-3',
      addPlaceholderValue: 'ex. gemini-3-flash',
      noMappings: 'Aucun mappage personnalise defini.',
      mapsTo: 'Mappe vers',
      default: 'Par defaut',
      restoreDefaults: 'Restaurer les valeurs par defaut',
    },
    modelVisibility: {
      title: 'Visibilite des modeles',
      description:
        'Controlez les modeles visibles dans les cartes de compte. Les modeles masques n apparaitront pas dans l affichage du quota.',
      searchPlaceholder: 'Rechercher des modeles...',
      showAll: 'Tout afficher',
      hideAll: 'Tout masquer',
      reset: 'Reinitialiser par defaut',
      save: 'Enregistrer les modifications',
      noModels: 'Aucun modele trouve',
      modelsShown: '{{visible}} sur {{total}} modeles visibles',
      quotaManagement: 'Gestion des quotas',
      hidden: 'Masque',
      noModelsFound: 'Aucun modele trouve',
      totalModels: 'Total',
      visibleModels: 'Visibles',
      hiddenModels: 'Masques',
      saving: 'Enregistrement...',
    },
    autoSwitchModels: {
      title: 'Auto-Switch Models Config',
      description:
        'Configure which models trigger auto-switch when depleted, and prioritize specific models when selecting the next active account.',
      searchPlaceholder: 'Search models...',
      noModels: 'No models found.',
      noModelsFound: 'No models found.',
      includeLabel: 'Include',
      priorityLabel: 'Priority',
      save: 'Save Config',
      saving: 'Saving...',
      saved: 'Auto-switch model configuration saved successfully.',
      saveFailed: 'Failed to save auto-switch model configuration.',
    },
    providerGroupings: {
      title: 'Groupements de fournisseurs',
      description: 'Regrouper les modeles par fournisseur pour une meilleure organisation',
      enabled: 'Activer les groupements de fournisseurs',
      models: '{{count}} modeles',
      avgLabel: 'moy.',
      resetLabel: 'reset',
      overall: 'Global',
      healthy: 'Sain',
      degraded: 'Degrade',
      limited: 'Limite',
      critical: 'Critique',
    },
    examples: {
      title: 'Exemples d utilisation',
      description: 'Exemples de commandes pour appeler le proxy API local.',
      curl: 'cURL',
      python: 'Python',
      copy: 'Copier',
      copied: 'Copie !',
      openai_protocol: 'Protocole OpenAI',
      anthropic_protocol: 'Protocole Anthropic',
      openai_tools: 'Cursor, Windsurf, NextChat',
      anthropic_tools: 'Claude Code CLI',
      flash: 'Rapide',
      pro: 'Pro',
      flash_preview: 'Apercu',
      pro_high: 'Meilleur',
      sonnet: 'Raisonnement',
      opus: 'Opus',
    },
    gateway: {
      title: 'Service proxy API',
      description: 'Controlez le serveur proxy API local.',
      status_running: 'En cours',
      status_stopped: 'Arrete',
      action_start: 'Demarrer le service',
      action_stop: 'Arreter le service',
      accounts_info: '{{count}} comptes disponibles',
      port: 'Port d ecoute',
      port_hint: 'Par defaut 8045, redemarrage requis pour appliquer les changements',
      timeout: 'Delai de requete',
      timeout_hint: 'Par defaut 120 s, plage 30-600 s',
      api_key: 'Cle API',
      regenerate_key: 'Regenerer',
      regenerateConfirm: {
        title: 'Regenerer la cle API ?',
        description:
          'Cela invalidera immediatement la cle API actuelle. Toute application utilisant l ancienne cle cessera de fonctionner.',
        cancel: 'Annuler',
        confirm: 'Regenerer',
      },
      key_warning: 'Gardez votre cle API en securite. Ne la partagez pas.',
      auto_start: 'Demarrage automatique avec l app',
      auto_start_desc: 'Demarrer le service proxy au lancement de l application',
    },
    proxy_tab: 'Proxy',
    save: 'Enregistrer les parametres',
  },
  toast: {
    backupSuccess: {
      title: 'Succes',
      description: 'Sauvegarde du compte creee avec succes.',
    },
    backupError: {
      title: 'Erreur',
      description: 'Echec de la creation de la sauvegarde : {{error}}',
    },
    switchSuccess: {
      title: 'Succes',
      description: 'Compte bascule avec succes.',
    },
    switchError: {
      title: 'Erreur',
      description: 'Echec du basculement de compte : {{error}}',
    },
    deleteSuccess: {
      title: 'Succes',
      description: 'Sauvegarde du compte supprimee avec succes.',
    },
    deleteError: {
      title: 'Erreur',
      description: 'Echec de la suppression de la sauvegarde : {{error}}',
    },
  },
  cloud: {
    title: 'Comptes',
    description: 'Gérez vos comptes Google Gemini.',
    security: {
      compatibilityMode: {
        title: 'Les clés de sécurité sont enregistrées sur cet ordinateur',
        description:
          'Le stockage sécurisé du système est indisponible. Les clés sont enregistrées dans un fichier local. Protégez cet ordinateur et ses sauvegardes.',
      },
    },
    autoSwitch: 'Basculement auto',
    providerGroupings: 'Groupements de fournisseurs',
    addAccount: 'Ajouter un compte',
    syncFromIde: 'Synchroniser depuis l IDE',
    checkQuota: 'Verifier le quota maintenant',
    polling: 'Interrogation declenchee',
    globalQuota: 'Quota global',
    layout: {
      auto: 'Auto',
      twoCol: '2 colonnes',
      threeCol: '3 colonnes',
      list: 'Liste',
      compact: 'Compact',
    },
    'quota-window': {
      label: 'Période de quota',
      'five-hours': 'Quota sur 5 heures',
      'five-hours-short': '5 h',
      weekly: 'Quota hebdomadaire',
      'weekly-short': 'Semaine',
      'compact-weekly-short': 'Sem.',
      'both-short': 'Les deux',
      'no-weekly-quota': 'Aucune donnée de quota hebdomadaire',
      'weekly-summary-unavailable':
        'Le service de modèles n’a pas fourni les informations d’utilisation hebdomadaire.',
      'weekly-bucket-unavailable':
        'L’utilisation hebdomadaire est absente des informations reçues.',
    },
    recommendation: {
      badge: 'Prochain recommandé',
      description: 'Sélectionné automatiquement à partir du dernier quota {{context}} récupéré.',
      context: {
        overall: 'global',
        claude: 'Claude',
        pro3: 'Gemini Pro',
        flash: 'Gemini Flash',
      },
    },
    authDialog: {
      title: 'Ajouter un compte Google',
      description:
        'Choisissez une méthode de connexion, puis connectez-vous à Google dans votre navigateur. Le compte sera ajouté automatiquement.',
      oauthClient: 'Méthode de connexion',
      oauthClientPlaceholder: 'Choisir une méthode de connexion',
      openLogin: 'Ouvrir la page de connexion',
      authCode: 'Code d autorisation',
      placeholder: 'Collez le code commencant par 4/...',
      instruction:
        'Si la connexion ne se termine pas automatiquement, collez ici le code du navigateur.',
      verify: 'Verifier et ajouter',
    },
    localImport: {
      ...en.cloud.localImport,
      description:
        'Recherchez les comptes déjà connectés à Antigravity sur cet ordinateur. Vérifiez les résultats avant l’importation.',
      emailCollision: '{{email}} possède {{count}} connexions enregistrées différentes.',
      sources: {
        ...en.cloud.localImport['sources'],
        'antigravity-keyring': 'Connexions enregistrées par le système',
        'antigravity-classic-db': 'Comptes enregistrés dans Antigravity',
        'antigravity-ide-db': 'Comptes enregistrés dans Antigravity IDE',
      },
      validationErrors: {
        ...en.cloud.localImport['validationErrors'],
        'credential-unavailable':
          'Ces informations de connexion ne sont plus disponibles. Reconnectez-vous à Antigravity, puis relancez la recherche.',
        'authentication-failed':
          'Google n’a pas accepté cette connexion. Reconnectez-vous à Antigravity, puis relancez la recherche.',
      },
      discoveryErrors: {
        ...en.cloud.localImport['discoveryErrors'],
        missing: 'Aucune connexion enregistrée n’a été trouvée ici.',
        'permission-denied':
          'L’accès aux informations de connexion a été refusé. Vérifiez les autorisations et réessayez.',
        locked:
          'Les informations de connexion sont verrouillées ou utilisées. Déverrouillez l’accès ou fermez Antigravity, puis relancez la recherche.',
        malformed:
          'Les informations de connexion sont illisibles. Reconnectez-vous à Antigravity, puis relancez la recherche.',
        'timed-out':
          'La lecture des informations de connexion a pris trop de temps. Relancez la recherche.',
        'read-failed': 'Impossible de lire les informations de connexion. Relancez la recherche.',
      },
      importErrors: {
        ...en.cloud.localImport['importErrors'],
        'credential-unavailable':
          'Ces informations de connexion ne sont plus disponibles. Relancez la recherche avant l’importation.',
        'identity-conflict':
          'Ces informations de connexion ne correspondent pas au compte existant. Vérifiez les comptes avant l’importation.',
      },
      errors: {
        ...en.cloud.localImport['errors'],
        'session-not-found': 'Ces résultats ne sont plus disponibles. Relancez la recherche.',
        'session-expired': 'Ces résultats ont expiré. Relancez la recherche.',
        'session-consumed':
          'Ces résultats ont déjà été utilisés. Relancez la recherche pour importer d’autres comptes.',
      },
    },
    card: {
      active: 'Actif',
      use: 'Utiliser',
      rateLimited: 'Limite par le debit',
      validationRiskControlled: 'Risque / limite par le debit',
      validationOAuthReauthRequired: 'Reconnectez-vous à Google',
      validationRequired: 'Verification requise',
      completeValidation: 'Verifier',
      left: 'restant',
      used: 'Utilise',
      unknown: 'Utilisateur inconnu',
      actions: 'Actions',
      useAccount: 'Utiliser le compte',
      identityProfile: 'Profil d identite',
      refresh: 'Actualiser le quota',
      delete: 'Supprimer le compte',
      noQuota: 'Aucune donnee de quota',
      rateLimitedQuota: 'Limite par le debit',
      liveLimitModelNotSupported: 'Modèle non pris en charge',
      liveLimitModelForbidden: 'Modèle interdit',
      liveLimitQuotaExhausted: 'Quota épuisé',
      liveLimitRateLimited: 'Débit limité',
      liveLimitRemaining: '{{duration}} restantes',
      liveLimitDetectedAgo: 'détecté il y a {{duration}}',
      liveLimitActiveTitle: 'Le service de modèles est temporairement indisponible.',
      liveLimitRecentTitle: 'Le service de modèles a récemment signalé une erreur.',
      liveLimitQuotaSnapshot:
        'La dernière vérification du quota peut encore afficher {{percentage}} %.',
      liveLimitMessage: 'Message : {{message}}',
      resetPrefix: 'reset',
      resetTime: 'Heure de reinitialisation',
      resetUnknown: 'Inconnue',
      detailedQuota: 'Quota detaille',
      quotaGroupUnknown: 'Groupe de quota',
      gemini3Ready: 'Pret pour Gemini 3',
      groupGoogleGemini: 'Google Gemini',
      groupAnthropicClaude: 'Anthropic Claude',
      proxy: 'Proxy',
      proxyPlaceholder: 'ex. http://127.0.0.1:7890',
      proxySaved: 'Proxy enregistre',
      'proxy-replace-placeholder': 'Saisir une nouvelle adresse proxy',
      'proxy-remove': 'Supprimer le proxy',
      'proxy-save-failed': "Impossible d'enregistrer le proxy",
      noProxy: 'Aucun proxy',
      aiCredits: 'Credits IA',
      aiCreditsValue: '{{amount}} credits',
      creditsExpiry: 'expire le {{date}}',
      modelVisibility: 'Visibilite des modeles',
    },
    identity: {
      'profile-errors': {
        'account-not-found': "Ce compte n'est plus disponible.",
        'baseline-unavailable': "Aucun profil d'identité d'origine à restaurer.",
        'revision-not-found': "Le profil d'identité choisi est introuvable.",
        'profile-invalid': "Ce profil d'identité ne peut pas être utilisé. Choisissez-en un autre.",
        'profile-write-failed': "Impossible d'enregistrer le profil d'identité. Réessayez.",
        'profile-operation-failed':
          "Impossible de terminer l'action sur le profil d'identité. Réessayez.",
      },
      title: 'Profil d identite',
      loading: 'Chargement...',
      generateAndBind: 'Creer et associer',
      captureAndBind: 'Capturer et associer l actuel',
      restoreOriginal: 'Restaurer la base',
      openFolder: 'Ouvrir le stockage d identite',
      previewTitle: 'Apercu de l identite generee',
      confirm: 'Confirmer',
      cancel: 'Annuler',
      close: 'Fermer',
      currentStorage: 'Réglages actuels de l’appareil',
      accountBinding: 'Identite associee au compte',
      history: 'Historique des identites',
      noHistory: 'Aucun historique d identite',
      current: 'Actif',
      restore: 'Restaurer',
      generateSuccess: 'Identite creee et associee',
      captureSuccess: 'Identite actuelle capturee et associee',
      restoreOriginalSuccess: 'Identite de base restauree',
      restoreVersionSuccess: 'Identite historique restauree',
      deleteVersionSuccess: 'Identite historique supprimee',
      openFolderSuccess: 'Stockage d identite ouvert',
      baseline: 'Identite de base',
    },
    list: {
      noAccounts: 'Aucun compte cloud ajoute pour le moment.',
      noFilteredAccounts: 'Aucun compte ne correspond aux niveaux selectionnes.',
    },
    error: {
      loadFailed: 'Echec du chargement des comptes cloud.',
      'report-issue': 'Signaler ce problème',
      'report-preparing': 'Préparation des informations…',
      'report-copied': 'Informations sur l’erreur copiées',
      'report-paste-guide':
        'Collez-les dans le formulaire GitHub, décrivez vos actions, puis envoyez le rapport.',
      'report-copy-failed': 'Impossible de copier les informations',
      'report-retry':
        'Réessayez. Vous pouvez aussi ouvrir les détails et copier l’erreur manuellement.',
      'report-open-failed': 'Impossible d’ouvrir GitHub',
      'report-manual-open':
        'Les informations sont copiées. Ouvrez {{url}} et collez-les dans le rapport.',
      dataRepair: {
        title: 'Impossible d’ouvrir les comptes enregistrés',
        description:
          'L’application ne peut pas lire certains comptes enregistrés. Cela peut arriver après un changement de compte sur l’ordinateur ou si des fichiers locaux sont endommagés.',
        stepReLogin:
          'Si le problème persiste après avoir rouvert l’application, reconnectez-vous ou ajoutez de nouveau les comptes concernés. Conservez vos données existantes jusqu’à leur restauration.',
        stepMacPrivacy:
          'Sur macOS, vérifiez les demandes d’autorisation. Déplacez l’application dans le dossier Applications, puis rouvrez-la.',
        stepCheckGithub:
          'Consultez le README du depot GitHub pour les dernieres etapes de depannage.',
        stepOpenIssue:
          'Signalez ce problème sur GitHub. Cliquez pour copier les informations et ouvrir le formulaire.',
        openRepository: 'Ouvrir le depot GitHub',
      },
    },
    toast: {
      syncSuccess: {
        title: 'Synchronisation reussie',
        description: '{{email}} importe depuis l IDE.',
      },
      syncFailed: {
        title: 'Echec de la synchronisation',
        description:
          'Aucun compte à synchroniser depuis Antigravity IDE. Connectez-vous d’abord dans l’IDE.',
        codes: {
          'reauth-required': 'Reconnectez-vous dans Antigravity IDE, puis réessayez.',
          'no-ide-account': 'Aucun compte Google trouvé dans Antigravity IDE.',
          'ide-database-unavailable':
            'Impossible de lire les comptes dans Antigravity IDE. Redémarrez l’IDE puis réessayez.',
          'agy-unsupported': 'Les comptes Antigravity CLI ne peuvent pas encore être importés ici.',
          'sync-failed': 'Impossible de synchroniser le compte IDE. Réessayez.',
        },
      },
      validationLinkFailed: {
        title: 'Impossible d’ouvrir la page de vérification Google',
        codes: {
          'account-not-found': 'Ce compte n’est plus disponible.',
          'no-trusted-link': 'Aucune page de vérification Google n’est disponible pour ce compte.',
          'validation-link-failed':
            'Impossible d’ouvrir la page de vérification Google. Réessayez.',
        },
      },
      addSuccess: 'Compte ajoute avec succes !',
      addFailed: {
        title: 'Echec de l ajout du compte',
        codes: {
          'authorization-denied': 'Autorisation Google refusee. Reessayez.',
          'login-active': 'Une connexion Google est deja en cours.',
          'login-cancelled': 'Connexion annulee.',
          'login-timeout': 'La connexion a expire. Recommencez.',
          'duplicate-account': 'Ce compte Google a deja ete ajoute.',
          'browser-open-failed':
            'Impossible d ouvrir le navigateur. Verifiez le navigateur par defaut.',
          'login-failed': 'Impossible d ajouter le compte. Reessayez.',
        },
      },
      quotaRefreshed: 'Quota actualise',
      refreshFailed: 'Echec de l actualisation du quota',
      pollFailed: 'Echec de l interrogation du quota pour tous les comptes',
      switched: {
        title: 'Compte bascule !',
        description: 'Redemarrage d Antigravity...',
      },
      switchFailed: 'Echec du basculement de compte',
      switchFailureCodes: {
        'account-not-found': "Ce compte n'est plus disponible.",
        'reauth-required': 'Reconnectez-vous à ce compte avant de basculer.',
        'identity-profile-required': 'Configurez un profil d’identité avant de basculer.',
        'process-control-failed': 'Impossible de fermer ou de redémarrer Antigravity. Réessayez.',
        'target-write-failed':
          'Impossible d’utiliser le compte choisi dans Antigravity. Réessayez.',
        'switch-failed': 'Impossible de changer de compte. Réessayez.',
      },
      deleted: 'Compte supprime',
      deleteFailed: 'Echec de la suppression du compte',
      deleteConfirm: 'Voulez-vous vraiment supprimer ce compte ?',
      autoSwitchOn: 'Basculement auto active',
      autoSwitchOff: 'Basculement auto desactive',
      updateSettingsFailed: 'Echec de la mise a jour des parametres',
      actionFailed: 'Action echouee',
      startAuthFailed: 'Echec du demarrage du flux de connexion',
      refreshCreditsAvailable: 'Credits IA : {{amount}}',
      refreshCreditsUnavailable: 'Credits IA indisponibles pour cette actualisation.',
      batchRefreshSuccess: '{{count}} comptes actualises avec succes.',
      batchRefreshPartial: {
        title: 'Actualisation terminee avec des problemes',
        description: '{{successful}} comptes actualises, {{failed}} en echec.',
      },
      batchDeleteSuccess: '{{count}} comptes supprimes avec succes.',
      batchDeletePartial: {
        title: 'Suppression terminee avec des problemes',
        description: '{{successful}} comptes supprimes, {{failed}} en echec.',
      },
    },
    batch: {
      selected: '{{count}} selectionnes',
      delete: 'Supprimer la selection',
      refresh: 'Actualiser la selection',
      selectAll: 'Tout selectionner',
      clear: 'Effacer la selection',
      confirmDelete: 'Voulez-vous vraiment supprimer {{count}} comptes ?',
    },
    tierFilter: {
      all: 'Tous les niveaux',
      reset: 'Reinitialiser a tous',
      selectedCount: '{{count}} niveaux',
      unknown: 'Inconnu',
    },
    sort: {
      recentlyUsed: 'Recemment utilises',
      quotaOverall: 'Quota global',
      quotaClaude: 'Quota Claude',
      quotaPro3: 'Quota Pro3',
      quotaFlash: 'Quota Flash',
    },
    exportImport: {
      'file-errors': {
        'file-too-large':
          'Le fichier choisi est trop volumineux. Choisissez une sauvegarde plus petite.',
        'invalid-export':
          'Cette sauvegarde de comptes est illisible. Choisissez un fichier valide.',
        'read-failed':
          'Impossible d’ouvrir le fichier choisi. Vérifiez qu’il est toujours présent.',
        'write-failed':
          'Impossible d’enregistrer la sauvegarde des comptes. Vérifiez l’emplacement choisi.',
        'import-failed': 'Impossible d’importer les comptes. Réessayez.',
        'tokens-missing':
          'Cette sauvegarde ne contient pas les données de connexion du compte. Exportez une sauvegarde qui les inclut.',
        'account-write-failed': 'Impossible de sauvegarder ce compte.',
      },
      export: 'Exporter',
      import: 'Importer',
      exportTitle: 'Exporter les comptes',
      exportDesc:
        'Choisissez si la sauvegarde contient les données de connexion. Gardez privées les sauvegardes qui les contiennent.',
      includeTokens: 'Inclure les données de connexion (restaure les comptes)',
      stripTokens: 'Sans données de connexion (plus sûr à partager)',
      exportSuccess: 'Comptes exportes avec succes',
      importTitle: 'Importer des comptes',
      importDesc: 'Selectionnez un fichier JSON exporte precedemment.',
      importStrategy: 'Strategie d importation',
      strategyMerge: 'Fusionner - mettre a jour l existant, ajouter le nouveau',
      strategyOverwrite: 'Ecraser - remplacer toutes les donnees existantes',
      strategySkip: 'Ignorer - ajouter seulement les nouveaux comptes',
      importSuccess: '{{imported}} importes, {{updated}} mis a jour, {{skipped}} ignores',
      importErrors: 'Importation terminee avec {{count}} erreur(s)',
      selectFile: 'Selectionner un fichier',
      importing: 'Importation...',
      fileTooLarge: 'La taille du fichier depasse la limite de 5 Mo',
      invalidJson: 'Format de fichier JSON invalide',
      readFileFailed: 'Echec de la lecture du fichier',
    },
  },
  proxy: {
    title: 'Proxy API',
    description: 'Gerez le service proxy API local.',
    save: 'Enregistrer les parametres',
    copy: 'Copier',
    copied: 'Copie !',
    regenerate: 'Regenerer',
    regenerateConfirm: {
      title: 'Regenerer la cle API ?',
      description:
        'Cela invalidera immediatement la cle API actuelle. Toute application utilisant l ancienne cle cessera de fonctionner.',
      cancel: 'Annuler',
      confirm: 'Regenerer',
    },
    'risk-confirmation': {
      title: 'Confirmez les risques avant de démarrer le proxy',
      description:
        'Depuis février, Google a renforcé ses mesures de contrôle. Le simple fait de changer de compte avec ce logiciel n’affecte pas votre compte Google.\n\nCependant, son utilisation comme proxy inverse ou à des fins similaires enfreint les conditions d’utilisation de Google et peut entraîner la suspension du compte.',
      'account-advice': 'Utilisez uniquement des comptes que vous pouvez vous permettre de perdre.',
      cancel: 'Annuler',
      confirm: 'Je comprends les risques. Démarrer le proxy',
    },
    service: {
      title: 'Statut du service',
      description: 'Controlez le serveur proxy API local.',
      running: 'En cours',
      stopped: 'Arrete',
      start: 'Demarrer le service',
      stop: 'Arreter le service',
      start_failed: 'Echec du demarrage du service',
      port_in_use_title: 'Port deja utilise',
      port_in_use_description:
        'Le port {{port}} est deja utilise par un autre processus. Fermez ce processus, ou modifiez le port d ecoute du proxy API dans les parametres puis reessayez.',
    },
    config: {
      port: 'Port d ecoute',
      timeout: 'Delai de requete',
      api_key: 'Cle API',
      auto_start: 'Demarrage automatique avec l app',
      auto_start_desc: 'Demarrer le service proxy au lancement de l application',
      cloud_code_meta: 'Compatibilité Cloud Code',
      cloud_code_meta_desc:
        'Ajouter les informations de réponse nécessaires aux anciens clients Cloud Code. Activez cette option uniquement si votre outil en a besoin ; les autres peuvent les refuser.',
      'allow-local-video-paths': 'Autoriser les chemins video locaux',
      'allow-local-video-paths-desc':
        'Autoriser les outils connectés à lire les vidéos de cet ordinateur accessibles à votre compte. Activez uniquement pour des outils de confiance.',
      'global-system-prompt-title': 'Consignes pour toutes les requêtes IA',
      'global-system-prompt-description':
        'Ajouter automatiquement ces consignes avant celles de chaque outil connecté, pour toute requête passant par Manager.',
      'global-system-prompt-placeholder':
        'Saisissez une invite système globale...\nExemple : Répondez en chinois simplifié et expliquez brièvement les modifications de code.',
      'global-system-prompt-character-count': '{{count}} caractères',
      'global-system-prompt-long-warning':
        'Plus de 2 000 caractères laissent moins de place à l’historique de conversation. Pensez à raccourcir ces consignes.',
      local_access: 'Acces reseau local :',
      select_ip: 'Selectionner une IP',
      no_token_warning: 'La cle API n est pas definie. L acces est ouvert a tout le monde !',
      show_key: 'Afficher',
      hide_key: 'Masquer',
    },
    mapping: {
      title: 'Mappage des modeles',
      description: 'Choisissez le modèle Gemini utilisé pour chaque demande de modèle Claude.',
      maps_to: 'Mappe vers',
      restore: 'Restaurer les valeurs par defaut',
      'only-raw-quota-models': 'Afficher uniquement les modèles trouvés dans vos comptes',
      'only-raw-quota-models-desc':
        'Les outils connectés voient uniquement les modèles des dernières vérifications de quota, sans noms supplémentaires.',
    },
    'open-code': {
      title: 'Synchronisation OpenCode',
      description:
        'Connectez OpenCode à Manager en conservant les autres réglages, commentaires et la mise en forme.',
      synced: 'Synchronisé',
      'synced-custom-url': 'Synchronisé avec une URL personnalisée',
      'not-synced': 'Non synchronisé',
      'config-path': 'Configuration',
      'configured-models': 'Modèles configurés',
      runtime: 'Installation d’OpenCode',
      installed: 'Installé',
      'not-installed': 'Non détecté',
      credential: 'Clé de connexion OpenCode',
      'key-stored': 'Enregistrée dans le stockage sécurisé du système',
      'key-missing': 'Créé lors de la prochaine synchronisation',
      'backup-notice':
        'Les sauvegardes conservent les commentaires et la mise en forme. La clé Manager est remplacée par une valeur inutilisable ; la restauration utilise la clé actuelle.',
      sync: 'Configurer et synchroniser OpenCode',
      restore: 'Restaurer la sauvegarde',
      clear: 'Effacer la configuration gérée',
      revoke: 'Révoquer la clé dédiée',
      'model-dialog-title': 'Choisir les modèles OpenCode',
      'model-dialog-description':
        'Les modèles sélectionnés sont ajoutés ou mis à jour. Les modèles existants non sélectionnés ne sont pas supprimés.',
      'custom-base-url': 'Adresse de Manager',
      'reset-base-url': 'Réinitialiser',
      'invalid-base-url': 'Saisissez une URL HTTP ou HTTPS valide.',
      'sync-accounts': 'Utiliser les comptes dans le module de connexion OpenCode',
      'sync-accounts-description':
        'Si cette option est activée, OpenCode enregistre dans un fichier sur cet ordinateur les informations qui maintiennent la connexion à ces comptes. Elle est désactivée par défaut. Activez-la uniquement sur un ordinateur de confiance.',
      'select-models': 'Modèles à ajouter ou à mettre à jour',
      'selected-count': '{{selected}} sur {{total}} sélectionnés',
      'select-all': 'Tout sélectionner',
      'deselect-all': 'Tout désélectionner',
      'confirm-sync': 'Confirmer la synchronisation',
      'auth-plugin-warning-title': 'Un autre module de connexion a été trouvé',
      'auth-plugin-warning-description':
        'opencode-antigravity-auth peut utiliser une autre connexion. Vérifiez que Manager est sélectionné dans OpenCode avant d’utiliser ces réglages.',
      'view-config': 'Afficher la configuration',
      'restore-confirm-title': 'Restaurer la sauvegarde OpenCode ?',
      'restore-confirm-description':
        'Le fichier entier sera remplacé par la sauvegarde initiale, y compris les modifications ultérieures. La sauvegarde sera ensuite supprimée.',
      'confirm-restore': 'Confirmer la restauration',
      'clear-confirm-title': 'Supprimer la connexion à Manager ?',
      'clear-confirm-description':
        'Cette connexion et sa clé seront supprimées. Les autres services, réglages et la sauvegarde seront conservés.',
      'confirm-clear': 'Confirmer l’effacement',
      'config-viewer-title': 'Configuration OpenCode',
      'config-viewer-description': 'Aperçu de la configuration en lecture seule',
      'config-redacted-notice': 'Les valeurs privées sont masquées dans cet aperçu.',
      'config-copied': 'Configuration copiée avec les données privées masquées',
      'config-copy-failed': 'Échec de la copie de la configuration',
      'config-load-failed': 'Échec du chargement de la configuration',
      'copy-config': 'Copier la configuration (données privées masquées)',
      'success-title': 'Configuration OpenCode mise à jour',
      'error-title': 'Échec de la mise à jour OpenCode',
      'unknown-error': 'Erreur de configuration OpenCode inconnue',
    },
    examples: {
      title: 'Exemples d utilisation',
      description: 'Exemples de commandes pour appeler le proxy API local.',
    },
    persistence: {
      title: 'Request history and reasoning',
      description: 'Inspect bounded local records without slowing model traffic.',
      'audit-title': 'Historique des requêtes',
      'audit-description':
        'Enregistrer sur cet ordinateur les requêtes, réponses et tentatives vers le service de modèles, en masquant les données sensibles.',
      rows: '{{count}} requests',
      queue: '{{count}} enregistrements en attente',
      dropped:
        '{{count}} enregistrements n’ont pas pu être sauvegardés ({{reason}}). Les requêtes ont continué normalement.',
      'disk-gib': 'Disk limit (GiB)',
      'body-hours': 'Conservation du contenu complet (heures)',
      'summary-days': 'Summary retention (days)',
      'max-rows': 'Maximum rows',
      'no-audit': 'No traffic records yet.',
      'audit-metadata': 'Détails des requêtes et tentatives vers le service de modèles',
      'audit-body-missing':
        'Le contenu complet de la requête ou de la réponse n’est plus enregistré.',
      'audit-body-expired':
        'Le contenu complet a expiré, mais les détails de la requête restent disponibles.',
      partial: 'Partial',
      'logical-size': 'Taille du contenu',
      'parse-error-offset': 'Position impossible à lire',
      loading: 'Loading…',
      'copy-progress': 'Preparing full copy: {{value}}%',
      'previous-page': 'Previous page',
      'next-page': 'Next page',
      'copy-full': 'Copy complete body',
      'confirm-copy-full': 'Confirm copying {{size}}',
      'clear-audit': 'Effacer l’historique des requêtes',
      'repair-audit': 'Réparer l’historique des requêtes',
      'thought-title': 'Reasoning history',
      'thought-description': 'Save reasoning so later turns can continue the conversation.',
      sessions: '{{count}} sessions',
      'hard-limit': 'Chaque conversation conserve au maximum 200 échanges et 64 MiB de contenu.',
      'retention-days': 'Retention (days)',
      'max-sessions': 'Maximum sessions',
      oversized: 'Le contenu dépasse 64 MiB et n’a pas été enregistré en entier.',
      'no-thought-body': 'No stored thought body.',
      signature: 'Signature',
      'copy-signature': 'Copy signature',
      'no-thought': 'No reasoning history yet.',
      'clear-thought': 'Clear reasoning history',
      'repair-thought': 'Repair reasoning history',
      'confirm-clear': 'Confirm clear',
      'confirm-repair': 'Confirm repair',
    },
  },
} satisfies typeof en;
export default fr;
