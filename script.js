// ================================
// CALENDARIO PULIZIE CASA v3.0
// Con Firebase Realtime Database
// ================================

// Stato dell'applicazione
let currentWeek = 1;
let settings = {
    names: ['Marco', 'Luca', 'Sara', 'Anna'],
    bagno1Name: 'Bagno MN',
    bagno2Name: 'Bagno PP',
    cucinaName: 'Cucina'
};
let tasksCompleted = {};
let trashPoints = [0, 0, 0, 0];
let shoppingPoints = [0, 0, 0, 0];
let shoppingList = [];
let rotation = {
    bagno1: [1, 2, 3, 4],
    bagno2: [2, 3, 4, 1],
    cucina: [3, 4, 1, 2]
};

// Variabili Firebase
let firebaseApp = null;
let database = null;
let firebaseUrl = localStorage.getItem('firebaseUrl') || '';
let isConnected = false;
let isLoading = false;
let isSaving = false;
let lastSyncTime = null;
// Configurazione restrizioni pulizie
const cleaningRestrictions = {
    bagno1: [0, 1, 2, 3], // Tutti di default
    bagno2: [0, 1, 2, 3], // Tutti di default
    cucina: [0, 1, 2, 3]  // Tutti di default
};
let customRotations = {
    enabled: false,
    weeks: {} // Conterrà le assegnazioni per ogni settimana
};

let skippedAssignments = {}; // Per tracciare chi ha saltato
let alternationState = {
    bagno1: { lastPerson: -1, cycle: [] },
    bagno2: { lastPerson: -1, cycle: [] }
};
function loadRestrictions() {
    // Carica restrizioni da settings se esistono
    if (settings.restrictions) {
        cleaningRestrictions.bagno1 = settings.restrictions.bagno1 || [0, 1, 2, 3];
        cleaningRestrictions.bagno2 = settings.restrictions.bagno2 || [0, 1, 2, 3];
        cleaningRestrictions.cucina = settings.restrictions.cucina || [0, 1, 2, 3];
    }
    
    updateRestrictionsDisplay();
}

function updateRestrictionsDisplay() {
    // Aggiorna nomi nelle etichette
    document.getElementById('bagno1RestrictionLabel').textContent = settings.bagno1Name;
    document.getElementById('bagno2RestrictionLabel').textContent = settings.bagno2Name;
    document.getElementById('cucinaRestrictionLabel').textContent = settings.cucinaName;
    
    // Aggiorna nomi delle persone
    ['bagno1', 'bagno2', 'cucina'].forEach(room => {
        for (let i = 0; i < 4; i++) {
            const nameSpan = document.getElementById(`${room}_name${i}`);
            if (nameSpan) {
                nameSpan.textContent = settings.names[i];
            }
        }
    });
    
    // Aggiorna checkbox
    ['bagno1', 'bagno2', 'cucina'].forEach(room => {
        for (let i = 0; i < 4; i++) {
            const checkbox = document.getElementById(`${room}_person${i}`);
            if (checkbox) {
                checkbox.checked = cleaningRestrictions[room].includes(i);
            }
        }
    });
}

async function saveRestrictions() {
    // Salva le restrizioni correnti
    const newRestrictions = {
        bagno1: [],
        bagno2: [],
        cucina: []
    };
    
    ['bagno1', 'bagno2', 'cucina'].forEach(room => {
        for (let i = 0; i < 4; i++) {
            const checkbox = document.getElementById(`${room}_person${i}`);
            if (checkbox && checkbox.checked) {
                newRestrictions[room].push(i);
            }
        }
        
        // Se nessuno è selezionato, permetti a tutti
        if (newRestrictions[room].length === 0) {
            newRestrictions[room] = [0, 1, 2, 3];
        }
    });
    
    // Aggiorna le restrizioni globali
    Object.assign(cleaningRestrictions, newRestrictions);
    
    // Salva nelle impostazioni
    settings.restrictions = newRestrictions;
    
    // Rigenera rotazioni con le nuove restrizioni
    rotation = generateValidRotations();
    renderSchedule();
    
    if (database) {
        await saveToFirebase();
    }
    
    showSaveIndicator('Restrizioni salvate! 🚫');
}

// Funzione per verificare conflitti
function hasConflict(assignments) {
    const assigned = new Set();
    
    for (const [room, person] of Object.entries(assignments)) {
        if (room === 'cucina') continue; // La cucina si controlla dopo
        if (assigned.has(person)) return true;
        assigned.add(person);
    }
    
    // Se chi fa bagno1 o bagno2 è assegnato anche alla cucina
    if (assignments.cucina && 
        (assignments.cucina === assignments.bagno1 || 
         assignments.cucina === assignments.bagno2)) {
        return true;
    }
    
    return false;
}
// ================================
// SISTEMA FIREBASE
// ================================

function initializeFirebase() {
    if (!firebaseUrl) {
        console.log('🔴 Firebase non configurato - modalità offline');
        updateConnectionStatus(false);
        return false;
    }
    
    try {
        // Configura Firebase
        const firebaseConfig = {
            databaseURL: firebaseUrl
        };
        
        // Inizializza Firebase se non già fatto
        if (!firebaseApp) {
            firebaseApp = firebase.initializeApp(firebaseConfig);
            database = firebase.database();
            
            // Listener per connessione
            const connectedRef = database.ref('.info/connected');
            connectedRef.on('value', (snapshot) => {
                isConnected = snapshot.val();
                updateConnectionStatus(isConnected);
                
                if (isConnected) {
                    console.log('🟢 Firebase connesso');
                    loadFromFirebase();
                } else {
                    console.log('🔴 Firebase disconnesso');
                }
            });
            
            // Listener per aggiornamenti dati
            database.ref('pulizieData').on('value', (snapshot) => {
                if (!isSaving) { // Evita loop infiniti
                    const data = snapshot.val();
                    if (data) {
                        loadDataFromSnapshot(data);
                    }
                }
            });
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Errore inizializzazione Firebase:', error);
        showSaveIndicator('Errore Firebase: ' + error.message + ' ❌');
        updateConnectionStatus(false);
        return false;
    }
}

function loadDataFromSnapshot(data) {
    try {
        // Carica tutti i dati esistenti
        currentWeek = data.currentWeek || getCurrentWeekOfYear();
        settings = { ...settings, ...data.settings };
        tasksCompleted = data.tasksCompleted || {};
        trashPoints = data.trashPoints || [0, 0, 0, 0];
        shoppingPoints = data.shoppingPoints || [0, 0, 0, 0];
        shoppingList = data.shoppingList || [];
        rotation = { ...rotation, ...data.rotation };
        
        // AGGIUNGI QUESTE RIGHE:
        skippedAssignments = data.skippedAssignments || {};
        alternationState = data.alternationState || {
            bagno1: { lastPerson: -1, cycle: [] },
            bagno2: { lastPerson: -1, cycle: [] }
        };
        customRotations = data.customRotations || {
            enabled: false,
            weeks: {}
        };
        
        if (data.settings && data.settings.restrictions) {
            cleaningRestrictions.bagno1 = data.settings.restrictions.bagno1 || [0, 1, 2, 3];
            cleaningRestrictions.bagno2 = data.settings.restrictions.bagno2 || [0, 1, 2, 3];
            cleaningRestrictions.cucina = data.settings.restrictions.cucina || [0, 1, 2, 3];
        }
        
        lastSyncTime = new Date();
        
        // Aggiorna interfaccia
        updateAllInterface();
        console.log('✅ Dati sincronizzati da Firebase');
        
    } catch (error) {
        console.error('❌ Errore caricamento dati:', error);
    }
}

async function loadFromFirebase() {
    if (!database || isLoading) return false;
    
    isLoading = true;
    showSaveIndicator('Caricamento da Firebase... 📥');
    
    try {
        const snapshot = await database.ref('pulizieData').once('value');
        const data = snapshot.val();
        
        if (data) {
            loadDataFromSnapshot(data);
            showSaveIndicator('Dati caricati da Firebase! ☁️');
            return true;
        } else {
            // Prima volta - salva dati attuali
            await saveToFirebase();
            showSaveIndicator('Primo accesso - dati salvati! 💾');
            return true;
        }
        
    } catch (error) {
        console.error('❌ Errore caricamento Firebase:', error);
        showSaveIndicator('Errore caricamento: ' + error.message + ' ❌');
        return false;
    } finally {
        isLoading = false;
    }
}

async function saveToFirebase() {
    if (!database || isSaving) return false;
    
    isSaving = true;
    
    const data = {
        currentWeek,
        settings,
        tasksCompleted,
        trashPoints,
        shoppingPoints,
        shoppingList,
        rotation,
        skippedAssignments,
        alternationState,
        customRotations, // AGGIUNGI QUESTA RIGA
        lastUpdate: new Date().toISOString(),
        version: '3.0'
    };
    
    try {
        await database.ref('pulizieData').set(data);
        lastSyncTime = new Date();
        console.log('✅ Dati salvati su Firebase');
        return true;
        
    } catch (error) {
        console.error('❌ Errore salvataggio Firebase:', error);
        showSaveIndicator('Errore salvataggio: ' + error.message + ' ❌');
        return false;
    } finally {
        isSaving = false;
    }
}

async function testFirebaseConnection() {
    if (!firebaseUrl) {
        showSaveIndicator('Inserisci prima l\'URL Firebase! ⚠️');
        return false;
    }
    
    showSaveIndicator('Test connessione... 🔄');
    
    try {
        // Prova a inizializzare
        const testConfig = {
            databaseURL: firebaseUrl
        };
        
        // Elimina app test esistente se presente
        try {
            const existingApp = firebase.app('test-app');
            await existingApp.delete();
        } catch (e) {
            // App non esiste, va bene
        }
        
        // Test di scrittura/lettura
        const testApp = firebase.initializeApp(testConfig, 'test-app');
        const testDb = testApp.database();
        
        // Scrivi test
        await testDb.ref('test').set({ timestamp: Date.now() });
        
        // Leggi test
        const snapshot = await testDb.ref('test').once('value');
        const testData = snapshot.val();
        
        if (testData) {
            // Pulisci test
            await testDb.ref('test').remove();
            
            // Elimina app test
            await testApp.delete();
            
            showSaveIndicator('Connessione Firebase OK! ✅');
            return true;
        } else {
            throw new Error('Test lettura fallito');
        }
        
    } catch (error) {
        console.error('❌ Test Firebase fallito:', error);
        showSaveIndicator('Test fallito: ' + error.message + ' ❌');
        return false;
    }
}

function saveFirebaseConfig() {
    const input = document.getElementById('firebaseUrl');
    const newUrl = input.value.trim();
    
    if (newUrl !== firebaseUrl) {
        firebaseUrl = newUrl;
        localStorage.setItem('firebaseUrl', firebaseUrl);
        
        if (firebaseUrl) {
            // Riavvia Firebase con nuova configurazione
            if (firebaseApp) {
                firebaseApp.delete().then(() => {
                    firebaseApp = null;
                    database = null;
                    initializeFirebase();
                });
            } else {
                initializeFirebase();
            }
            showSaveIndicator('Configurazione Firebase salvata! ⚙️');
        } else {
            // Disabilita Firebase
            if (firebaseApp) {
                firebaseApp.delete();
                firebaseApp = null;
                database = null;
            }
            updateConnectionStatus(false);
            showSaveIndicator('Firebase disabilitato - modalità offline! 📱');
        }
    }
}

function updateConnectionStatus(connected) {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        if (connected) {
            statusElement.textContent = '🟢 Connesso a Firebase';
            statusElement.style.color = '#28a745';
        } else if (firebaseUrl) {
            statusElement.textContent = '🟡 Tentativo connessione...';
            statusElement.style.color = '#ffc107';
        } else {
            statusElement.textContent = '🔴 Modalità offline';
            statusElement.style.color = '#dc3545';
        }
    }
}

// ================================
// FUNZIONI CALENDARIO E UI
// ================================

function getCurrentWeekOfYear() {
    const now = new Date();
    const romeTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const startOfYear = new Date(romeTime.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((romeTime - startOfYear) / (24 * 60 * 60 * 1000)) + 1;
    const weekOfYear = Math.ceil(dayOfYear / 7);
    return Math.min(weekOfYear, 52);
}

function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.getElementById(tabName).classList.add('active');
    event.target.classList.add('active');
    
    // Aggiorna contenuto specifico per tab
    switch(tabName) {
        case 'calendario':
            renderSchedule();
            break;
        case 'immondizia':
            updatePointsDisplay();
            updateNextTrashPerson();
            break;
        case 'spesa':
            updateShoppingList();
            updateShoppingPointsDisplay();
            updateNextShoppingPerson();
            break;
    }
}

async function changeWeek(direction) {
    currentWeek += direction;
    if (currentWeek < 1) currentWeek = 1;
    if (currentWeek > 52) currentWeek = 52;
    
    document.getElementById('weekNumber').textContent = currentWeek;
    updateWeekDates();
    renderSchedule();
    
    if (database) {
        await saveToFirebase();
    }
}
async function goToCurrentWeek() {
    const todayWeek = getCurrentWeekOfYear();
    if (currentWeek !== todayWeek) {
        currentWeek = todayWeek;
        document.getElementById('weekNumber').textContent = currentWeek;
        updateWeekDates();
        renderSchedule();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Tornato alla settimana corrente! 📍');
    }
}
function updateWeekDates() {
    const today = new Date();
    const romeTime = new Date(today.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const startOfYear = new Date(romeTime.getFullYear(), 0, 1);
    const startOfWeek = new Date(startOfYear);
    startOfWeek.setDate(startOfYear.getDate() + (currentWeek - 1) * 7);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    const formatDate = (date) => {
        return date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    };
    
    document.getElementById('weekDates').textContent = 
        `${formatDate(startOfWeek)} - ${formatDate(endOfWeek)}`;
}

// Modifica della funzione renderSchedule() per aggiungere il dropdown
function renderSchedule() {
    const grid = document.getElementById('scheduleGrid');
    let bagno1Person, bagno2Person, cucinaPersona;
    
    // NUOVO: Usa turnazioni personalizzate se abilitate
    if (customRotations.enabled && customRotations.weeks[currentWeek]) {
        const customWeek = customRotations.weeks[currentWeek];
        bagno1Person = customWeek.bagno1;
        bagno2Person = customWeek.bagno2;
        cucinaPersona = customWeek.cucina;
    } else {
        // Usa rotazione automatica normale
        const weekIndex = (currentWeek - 1) % 4;
        bagno1Person = rotation.bagno1[weekIndex];
        bagno2Person = rotation.bagno2[weekIndex];
        cucinaPersona = rotation.cucina[weekIndex];
    }
    
    const tasks = [
        {
            id: 'bagno1',
            title: settings.bagno1Name,
            icon: '🚿',
            person: bagno1Person,
            class: 'bagno1'
        },
        {
            id: 'bagno2',
            title: settings.bagno2Name,
            icon: '🛁',
            person: bagno2Person,
            class: 'bagno2'
        },
        {
            id: 'cucina',
            title: settings.cucinaName,
            icon: '🍳',
            person: cucinaPersona,
            class: 'cucina'
        }
    ];
    
    grid.innerHTML = tasks.map(task => {
        const taskKey = `week${currentWeek}_${task.id}`;
        const isCompleted = tasksCompleted[taskKey] || false;
        
        // Genera opzioni per il dropdown
        const personOptions = settings.names.map((name, index) => 
            `<option value="${index + 1}" ${(index + 1) === task.person ? 'selected' : ''}>${name}</option>`
        ).join('');
        
        return `
            <div class="task-card ${task.class}">
                <div class="task-icon">${task.icon}</div>
                <div class="task-title">${task.title}</div>
                <div class="assigned-person">${settings.names[task.person - 1]}</div>
                
                <!-- Dropdown per cambiare assegnazione -->
                <div class="change-assignment">
                    <label style="font-size: 12px; color: #666;">Cambia assegnazione:</label>
                    <select onchange="changeAssignment('${task.id}', this.value)" class="assignment-select" ${isCompleted ? 'disabled' : ''}>
                        ${personOptions}
                    </select>
                </div>
                
                <div class="task-status">
                    <input type="checkbox" 
                           class="task-checkbox"
                           ${isCompleted ? 'checked' : ''}
                           onchange="toggleTask('${task.id}')">
                    <span>${isCompleted ? 'Completato!' : 'Da fare'}</span>
                </div>
                <div class="skip-turn-container">
                    <button onclick="skipTurn('${task.id}')" class="btn-skip-turn" ${isCompleted ? 'disabled' : ''}>
                        ⏭️ Salta Turno
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function renderCustomRotationsEditor() {
    const container = document.getElementById('customRotationsContainer');
    if (!container) return;
    
    const isEnabled = customRotations.enabled;
    
    container.innerHTML = `
        <div class="custom-rotations-header">
            <label class="custom-rotations-toggle">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleCustomRotations()">
                <span>Abilita Turnazioni Personalizzate</span>
            </label>
            ${isEnabled ? '<p class="custom-rotations-info">📝 Modifica le assegnazioni settimana per settimana</p>' : ''}
        </div>
        
        ${isEnabled ? `
            <div class="custom-rotations-editor">
                <div class="weeks-navigation">
                    <button onclick="navigateCustomWeeks(-4)" class="btn-nav">⬅️ -4 sett</button>
                    <button onclick="navigateCustomWeeks(-1)" class="btn-nav">⬅️ -1 sett</button>
                    <span id="customWeekRange">Settimane 1-4</span>
                    <button onclick="navigateCustomWeeks(1)" class="btn-nav">+1 sett ➡️</button>
                    <button onclick="navigateCustomWeeks(4)" class="btn-nav">+4 sett ➡️</button>
                </div>
                <div id="customRotationsTable"></div>
                <div class="custom-rotations-actions">
                    <button onclick="saveCustomRotations()" class="btn-save">💾 Salva Turnazioni</button>
                    <button onclick="copyFromAutoRotation()" class="btn-copy">📋 Copia da Rotazione Automatica</button>
                </div>
            </div>
        ` : ''}
    `;
    
    if (isEnabled) {
        renderCustomRotationsTable();
    }
}

// Variabile per navigazione settimane nell'editor
let customEditorStartWeek = 1;

// Funzione per navigare tra le settimane nell'editor
function navigateCustomWeeks(direction) {
    customEditorStartWeek += direction;
    if (customEditorStartWeek < 1) customEditorStartWeek = 1;
    if (customEditorStartWeek > 49) customEditorStartWeek = 49; // Max 49 per mostrare 4 settimane
    
    renderCustomRotationsTable();
}

// Funzione per renderizzare la tabella delle turnazioni personalizzate
function renderCustomRotationsTable() {
    const tableContainer = document.getElementById('customRotationsTable');
    const rangeElement = document.getElementById('customWeekRange');
    
    if (!tableContainer || !rangeElement) return;
    
    const endWeek = Math.min(customEditorStartWeek + 3, 52);
    rangeElement.textContent = `Settimane ${customEditorStartWeek}-${endWeek}`;
    
    let tableHTML = `
        <table class="custom-rotations-table">
            <thead>
                <tr>
                    <th>Settimana</th>
                    <th>${settings.bagno1Name}</th>
                    <th>${settings.bagno2Name}</th>
                    <th>${settings.cucinaName}</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    for (let week = customEditorStartWeek; week <= endWeek; week++) {
        const weekData = customRotations.weeks[week] || getDefaultWeekAssignment(week);
        
        tableHTML += `
            <tr>
                <td class="week-number">${week}</td>
                <td>
                    <select onchange="updateCustomWeekAssignment(${week}, 'bagno1', this.value)">
                        ${settings.names.map((name, index) => 
                            `<option value="${index + 1}" ${weekData.bagno1 === (index + 1) ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </td>
                <td>
                    <select onchange="updateCustomWeekAssignment(${week}, 'bagno2', this.value)">
                        ${settings.names.map((name, index) => 
                            `<option value="${index + 1}" ${weekData.bagno2 === (index + 1) ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </td>
                <td>
                    <select onchange="updateCustomWeekAssignment(${week}, 'cucina', this.value)">
                        ${settings.names.map((name, index) => 
                            `<option value="${index + 1}" ${weekData.cucina === (index + 1) ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </td>
            </tr>
        `;
    }
    
    tableHTML += `
            </tbody>
        </table>
    `;
    
    tableContainer.innerHTML = tableHTML;
}

// Funzione per ottenere assegnazione di default per una settimana
function getDefaultWeekAssignment(week) {
    const weekIndex = (week - 1) % 4;
    return {
        bagno1: rotation.bagno1[weekIndex],
        bagno2: rotation.bagno2[weekIndex],
        cucina: rotation.cucina[weekIndex]
    };
}

// Funzione per attivare/disattivare le turnazioni personalizzate
async function toggleCustomRotations() {
    const checkbox = event.target;
    customRotations.enabled = checkbox.checked;
    
    if (customRotations.enabled) {
        // Inizializza con rotazione automatica corrente
        initializeCustomRotationsFromAuto();
    }
    
    renderCustomRotationsEditor();
    renderSchedule(); // Aggiorna il calendario
    
    if (database) {
        await saveToFirebase();
    }
    
    const message = customRotations.enabled ? 
        'Turnazioni personalizzate abilitate! 🔧' : 
        'Tornato alla rotazione automatica! 🔄';
    showSaveIndicator(message);
}

// Funzione per inizializzare le turnazioni personalizzate dalla rotazione automatica
function initializeCustomRotationsFromAuto() {
    customRotations.weeks = {};
    
    // Popola tutte le 52 settimane
    for (let week = 1; week <= 52; week++) {
        customRotations.weeks[week] = getDefaultWeekAssignment(week);
    }
}

// Funzione per aggiornare assegnazione di una settimana specifica
async function updateCustomWeekAssignment(week, room, personId) {
    if (!customRotations.weeks[week]) {
        customRotations.weeks[week] = getDefaultWeekAssignment(week);
    }
    
    customRotations.weeks[week][room] = parseInt(personId);
    
    // Se stiamo modificando la settimana corrente, aggiorna il calendario
    if (week === currentWeek) {
        renderSchedule();
    }
    
    if (database) {
        await saveToFirebase();
    }
}

// Funzione per salvare le turnazioni personalizzate
async function saveCustomRotations() {
    if (database) {
        await saveToFirebase();
    }
    
    showSaveIndicator('Turnazioni personalizzate salvate! 💾');
}

// Funzione per copiare dalla rotazione automatica
async function copyFromAutoRotation() {
    if (confirm('Vuoi sovrascrivere le turnazioni personalizzate con quelle automatiche?')) {
        initializeCustomRotationsFromAuto();
        renderCustomRotationsTable();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Turnazioni copiate dalla rotazione automatica! 📋');
    }
}

// Funzione per ripristinare la rotazione automatica
async function resetToAutoRotation() {
    if (confirm('Vuoi disabilitare le turnazioni personalizzate e tornare alla rotazione automatica?')) {
        customRotations.enabled = false;
        customRotations.weeks = {};
        
        renderCustomRotationsEditor();
        renderSchedule();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Ripristinata rotazione automatica! 🔄');
    }
}

// NUOVA FUNZIONE: Cambia assegnazione per la settimana corrente
async function changeAssignment(roomId, newPersonId) {
    const weekIndex = (currentWeek - 1) % 4;
    const personIndex = parseInt(newPersonId);
    
    // Trova l'indice nella rotazione originale
    let rotationKey;
    switch(roomId) {
        case 'bagno1':
            rotationKey = 'bagno1';
            break;
        case 'bagno2':
            rotationKey = 'bagno2';
            break;
        case 'cucina':
            rotationKey = 'cucina';
            break;
    }
    
    if (rotationKey) {
        // Salva il cambiamento
        const changeKey = `week${currentWeek}_${roomId}_override`;
        if (!tasksCompleted[changeKey + '_original']) {
            // Salva l'assegnazione originale solo la prima volta
            tasksCompleted[changeKey + '_original'] = rotation[rotationKey][weekIndex];
        }
        
        // Aggiorna la rotazione corrente
        rotation[rotationKey][weekIndex] = personIndex;
        
        // Rigenera le settimane successive basandosi sulla nuova assegnazione
        updateRotationFromWeek(currentWeek + 1, rotationKey, personIndex);
        
        // NUOVO: Controlla e risolvi conflitti
        await fixConflicts();
        
        // Aggiorna l'interfaccia
        renderSchedule();
        
        // Salva su Firebase
        if (database) {
            await saveToFirebase();
        }
        
        const roomName = roomId === 'bagno1' ? settings.bagno1Name : 
                        roomId === 'bagno2' ? settings.bagno2Name : settings.cucinaName;
        const personName = settings.names[personIndex - 1];
        
        showSaveIndicator(`${roomName} assegnato a ${personName} per questa settimana! 🔄`);
    }
}

// NUOVA FUNZIONE: Aggiorna la rotazione dalle settimane successive
function updateRotationFromWeek(startWeek, roomType, lastPersonId) {
    // Ottieni le persone disponibili per questa stanza
    const availablePeople = cleaningRestrictions[roomType] || [0, 1, 2, 3];
    
    // Trova l'indice della persona che ha appena pulito
    const lastPersonIndex = availablePeople.indexOf(lastPersonId - 1);
    
    // Aggiorna le rotazioni per le prossime settimane (fino a 4 settimane avanti)
    for (let week = startWeek; week <= startWeek + 3; week++) {
        const weekIndex = (week - 1) % 4;
        if (weekIndex >= 0 && weekIndex < 4) {
            // Calcola chi dovrebbe pulire basandosi sulla rotazione
            const weeksFromChange = week - startWeek;
            const nextPersonIndex = (lastPersonIndex + 1 + weeksFromChange) % availablePeople.length;
            const nextPersonId = availablePeople[nextPersonIndex] + 1;
            
            rotation[roomType][weekIndex] = nextPersonId;
        }
    }
}


async function toggleTask(taskId) {
    const taskKey = `week${currentWeek}_${taskId}`;
    tasksCompleted[taskKey] = !tasksCompleted[taskKey];
    renderSchedule();
    
    if (database) {
        await saveToFirebase();
    }
}

function updateSettings() {
    const selectors = ['bagno1Person', 'bagno2Person', 'cucinaPersona'];
    selectors.forEach(selectorId => {
        const select = document.getElementById(selectorId);
        if (select) {
            const currentValue = select.value;
            select.innerHTML = settings.names.map((name, index) => 
                `<option value="${index + 1}" ${currentValue == (index + 1) ? 'selected' : ''}>${name}</option>`
            ).join('');
        }
    });
    
    const bagno1Label = document.getElementById('bagno1Label');
    const bagno2Label = document.getElementById('bagno2Label');
    const cucinaLabel = document.getElementById('cucinaLabel');
    
    if (bagno1Label) bagno1Label.textContent = settings.bagno1Name;
    if (bagno2Label) bagno2Label.textContent = settings.bagno2Name;
    if (cucinaLabel) cucinaLabel.textContent = settings.cucinaName;
    
    // AGGIUNGI QUESTA RIGA:
    updateRestrictionsDisplay();
}


async function saveSettings() {
    settings.names[0] = document.getElementById('name1').value;
    settings.names[1] = document.getElementById('name2').value;
    settings.names[2] = document.getElementById('name3').value;
    settings.names[3] = document.getElementById('name4').value;
    settings.bagno1Name = document.getElementById('bagno1Name').value;
    settings.bagno2Name = document.getElementById('bagno2Name').value;
    settings.cucinaName = document.getElementById('cucinaName').value;
    
    updateSettings();
    renderSchedule();
    updatePointsDisplay();
    updateShoppingPointsDisplay();
    
    if (database) {
        await saveToFirebase();
    }
}

// Aggiungi questa nuova funzione per verificare e correggere conflitti esistenti
async function fixConflicts() {
    let hasChanges = false;
    
    // Controlla tutte le settimane della rotazione corrente
    for (let week = 0; week < 4; week++) {
        const actualWeek = currentWeek + week;
        const weekIndex = (actualWeek - 1) % 4;
        
        const bagno1Person = rotation.bagno1[weekIndex];
        const bagno2Person = rotation.bagno2[weekIndex];
        const cucinaPerson = rotation.cucina[weekIndex];
        
        // Controlla se c'è conflitto
        if (cucinaPerson === bagno1Person || cucinaPerson === bagno2Person) {
            // Trova una persona alternativa per la cucina
            const availableForKitchen = cleaningRestrictions.cucina.map(p => p + 1); // +1 per formato 1-4
            const alternativeOptions = availableForKitchen.filter(p => 
                p !== bagno1Person && p !== bagno2Person
            );
            
            if (alternativeOptions.length > 0) {
                // Usa la prima opzione disponibile
                rotation.cucina[weekIndex] = alternativeOptions[0];
                hasChanges = true;
                console.log(`🔧 Conflitto risolto settimana ${actualWeek}: cucina assegnata a ${settings.names[alternativeOptions[0] - 1]}`);
            }
        }
    }
    
    if (hasChanges) {
        renderSchedule();
        if (database) {
            await saveToFirebase();
        }
        showSaveIndicator('Conflitti risolti automaticamente! 🔧');
    }
    
    return hasChanges;
}

async function updateRotation() {
    // Rigenera rotazioni con le nuove restrizioni
    rotation = generateValidRotations();
    
    renderSchedule();
    
    if (database) {
        await saveToFirebase();
    }
}
// Nuova funzione per ottenere assegnazione di una settimana specifica
// Nuova funzione per ottenere assegnazione di una settimana specifica
function getWeekAssignment(weekOffset) {
    const actualWeek = currentWeek + weekOffset;
    const weekKey = `week${actualWeek}`;
    
    // Ottieni chi ha pulito la settimana precedente per evitare ripetizioni
    const previousWeek = actualWeek - 1;
    let excludeBagno1 = [];
    let excludeBagno2 = [];
    
    // Se c'è una settimana precedente, escludi chi ha già pulito
    if (previousWeek > 0) {
        const prevAssignment = getWeekAssignmentRaw(previousWeek);
        if (prevAssignment) {
            excludeBagno1.push(prevAssignment.bagno1);
            excludeBagno2.push(prevAssignment.bagno2);
        }
    }
    
    // Controlla chi ha saltato il turno questa settimana
    if (skippedAssignments[weekKey]) {
        if (skippedAssignments[weekKey].bagno1 !== undefined) {
            excludeBagno1.push(skippedAssignments[weekKey].bagno1);
        }
        if (skippedAssignments[weekKey].bagno2 !== undefined) {
            excludeBagno2.push(skippedAssignments[weekKey].bagno2);
        }
    }
    
    // Assegna bagno1 e bagno2 con le esclusioni
    let bagno1Person = getNextPersonForRoomExcluding('bagno1', actualWeek, excludeBagno1);
    let bagno2Person = getNextPersonForRoomExcluding('bagno2', actualWeek, excludeBagno2);
    
    // NUOVA LOGICA PER LA CUCINA - Evita conflitti con bagni
    let cucinaPerson;
    const availableForKitchen = [...cleaningRestrictions.cucina];
    
    // Escludi chi fa già i bagni questa settimana
    const excludeForKitchen = [bagno1Person, bagno2Person];
    const availableWithoutConflicts = availableForKitchen.filter(p => !excludeForKitchen.includes(p));
    
    if (availableWithoutConflicts.length > 0) {
        // Se ci sono persone disponibili senza conflitti, usale
        cucinaPerson = availableWithoutConflicts[(actualWeek - 1) % availableWithoutConflicts.length];
    } else {
        // Se tutti hanno conflitti, usa la rotazione normale (caso estremo)
        cucinaPerson = availableForKitchen[(actualWeek - 1) % availableForKitchen.length];
    }
    
    return {
        bagno1: bagno1Person,
        bagno2: bagno2Person,
        cucina: cucinaPerson
    };
}
// Funzione per ottenere assegnazione raw (senza esclusioni)
function getWeekAssignmentRaw(week) {
    const weekIndex = (week - 1) % 4;
    if (rotation && rotation.bagno1 && rotation.bagno2) {
        return {
            bagno1: rotation.bagno1[weekIndex] - 1, // -1 perché il sistema usa 0-3 internamente
            bagno2: rotation.bagno2[weekIndex] - 1,
            cucina: rotation.cucina[weekIndex] - 1
        };
    }
    return null;
}

// Funzione per ottenere prossima persona escludendo alcune
function getNextPersonForRoomExcluding(room, week, excludePersons = []) {
    // Assicurati che il ciclo esista
    if (!alternationState[room] || !alternationState[room].cycle || alternationState[room].cycle.length === 0) {
        alternationState[room] = {
            lastPerson: -1,
            cycle: [...cleaningRestrictions[room]]
        };
    }
    
    // Filtra le persone disponibili
    const available = cleaningRestrictions[room].filter(p => !excludePersons.includes(p));
    
    if (available.length === 0) {
        // Se nessuno è disponibile, usa tutti
        return cleaningRestrictions[room][week % cleaningRestrictions[room].length];
    }
    
    // Usa rotazione tra quelli disponibili
    return available[week % available.length];
}
// Funzione per ottenere la prossima persona per una stanza con alternanza rigida
function getNextPersonForRoom(room, week, excludePersons = []) {
    // Assicurati che il ciclo esista
    if (!alternationState[room] || !alternationState[room].cycle || alternationState[room].cycle.length === 0) {
        alternationState[room] = {
            lastPerson: -1,
            cycle: [...cleaningRestrictions[room]]
        };
    }
    
    const cycle = alternationState[room].cycle.filter(p => !excludePersons.includes(p));
    if (cycle.length === 0) return alternationState[room].cycle[0];
    
    const index = (week - 1) % cycle.length;
    return cycle[index];
}

// Funzione utility per mescolare array
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Nuova funzione per saltare turno
async function skipTurn(room) {
    const weekKey = `week${currentWeek}`;
    const currentAssignment = getWeekAssignment(0);
    const currentPerson = currentAssignment[room];
    
    if (!skippedAssignments[weekKey]) {
        skippedAssignments[weekKey] = {};
    }
    
    skippedAssignments[weekKey][room] = currentPerson;
    
    // Rigenera rotazioni
    rotation = generateValidRotations();
    renderSchedule();
    
    if (database) {
        await saveToFirebase();
    }
    
    const personName = settings.names[currentPerson];
    const roomName = room === 'bagno1' ? settings.bagno1Name : 
                     room === 'bagno2' ? settings.bagno2Name : settings.cucinaName;
    
    showSaveIndicator(`${personName} ha saltato il turno per ${roomName} - verrà recuperato! ⏭️`);
}

function generateValidRotations() {
    const rotations = { bagno1: [], bagno2: [], cucina: [] };
    
    // Reset degli stati di alternanza
    alternationState = {
        bagno1: { lastPerson: -1, cycle: shuffleArray([...cleaningRestrictions.bagno1]) },
        bagno2: { lastPerson: -1, cycle: shuffleArray([...cleaningRestrictions.bagno2]) }
    };
    
    // Genera assegnazioni per 4 settimane rispettando TUTTI i vincoli
    for (let week = 0; week < 4; week++) {
        let bagno1Person, bagno2Person, cucinaPerson;
        let attempts = 0;
        let validAssignment = false;
        
        // Prova fino a trovare un'assegnazione valida (massimo 50 tentativi)
        while (!validAssignment && attempts < 50) {
            attempts++;
            
            // Assegna bagno1 (alternanza rigida)
            const bagno1Available = cleaningRestrictions.bagno1;
            const bagno1Index = week % bagno1Available.length;
            bagno1Person = bagno1Available[bagno1Index] + 1; // +1 per formato 1-4
            
            // Assegna bagno2 (alternanza rigida, diverso da bagno1)
            const bagno2Available = cleaningRestrictions.bagno2.filter(p => p !== (bagno1Person - 1));
            if (bagno2Available.length === 0) {
                // Se non ci sono alternative, usa tutti i disponibili per bagno2
                bagno2Available = [...cleaningRestrictions.bagno2];
            }
            const bagno2Index = week % bagno2Available.length;
            bagno2Person = bagno2Available[bagno2Index] + 1;
            
            // Assegna cucina (DEVE essere diverso da chi fa i bagni)
            const cucinaAvailable = cleaningRestrictions.cucina.filter(p => 
                p !== (bagno1Person - 1) && p !== (bagno2Person - 1)
            );
            
            if (cucinaAvailable.length > 0) {
                // Usa rotazione tra quelli disponibili per la cucina
                const cucinaIndex = week % cucinaAvailable.length;
                cucinaPerson = cucinaAvailable[cucinaIndex] + 1;
                validAssignment = true;
            } else {
                // Se non ci sono persone disponibili per la cucina, riprova con diversa combinazione bagni
                // Cambia l'assegnazione dei bagni
                if (attempts < 25) {
                    continue; // Riprova
                } else {
                    // Forza una soluzione: assegna comunque la cucina al primo disponibile
                    cucinaPerson = cleaningRestrictions.cucina[0] + 1;
                    validAssignment = true;
                    console.warn(`⚠️ Forzata assegnazione cucina settimana ${week + 1} - possibile conflitto`);
                }
            }
        }
        
        // Verifica finale dei conflitti
        if (cucinaPerson === bagno1Person || cucinaPerson === bagno2Person) {
            console.warn(`⚠️ Conflitto rilevato settimana ${week + 1}: ${settings.names[cucinaPerson-1]} ha sia bagno che cucina`);
        }
        
        rotations.bagno1.push(bagno1Person);
        rotations.bagno2.push(bagno2Person);
        rotations.cucina.push(cucinaPerson);
    }
    
    console.log('✅ Turnazioni generate:', rotations);
    return rotations;
}

// Funzione per validare le turnazioni generate
function validateRotations(rotations) {
    let isValid = true;
    const errors = [];
    
    for (let week = 0; week < 4; week++) {
        const bagno1 = rotations.bagno1[week] - 1; // -1 per formato 0-3
        const bagno2 = rotations.bagno2[week] - 1;
        const cucina = rotations.cucina[week] - 1;
        
        // Verifica restrizioni bagno1
        if (!cleaningRestrictions.bagno1.includes(bagno1)) {
            errors.push(`Settimana ${week + 1}: ${settings.names[bagno1]} non può pulire ${settings.bagno1Name}`);
            isValid = false;
        }
        
        // Verifica restrizioni bagno2
        if (!cleaningRestrictions.bagno2.includes(bagno2)) {
            errors.push(`Settimana ${week + 1}: ${settings.names[bagno2]} non può pulire ${settings.bagno2Name}`);
            isValid = false;
        }
        
        // Verifica restrizioni cucina
        if (!cleaningRestrictions.cucina.includes(cucina)) {
            errors.push(`Settimana ${week + 1}: ${settings.names[cucina]} non può pulire ${settings.cucinaName}`);
            isValid = false;
        }
        
        // Verifica conflitti (stessa persona bagno + cucina)
        if (cucina === bagno1 || cucina === bagno2) {
            errors.push(`Settimana ${week + 1}: ${settings.names[cucina]} ha sia bagno che cucina`);
            isValid = false;
        }
    }
    
    if (!isValid) {
        console.error('❌ Errori nelle turnazioni:', errors);
    }
    
    return { isValid, errors };
}
// ================================
// SISTEMA PUNTI SPAZZATURA
// ================================

function updatePointsDisplay() {
    const container = document.getElementById('trashPointsContainer');
    if (!container) return;
    
    // Crea array con indici e punti per ordinamento
    const peopleWithPoints = settings.names.map((name, index) => ({
        name,
        index,
        points: trashPoints[index]
    }));
    
    // Ordina per punti crescenti (meno punti = più priorità)
    peopleWithPoints.sort((a, b) => a.points - b.points);
    
    container.innerHTML = peopleWithPoints.map(person => `
        <div class="points-card">
            <div class="person-name">${person.name}</div>
            <div class="points-value">${person.points} punti</div>
            <div class="points-buttons">
                <button onclick="addTrashPoint(${person.index})" class="btn-point add">+1</button>
                <button onclick="removeTrashPoint(${person.index})" class="btn-point remove">-1</button>
            </div>
        </div>
    `).join('');
}

async function addTrashPoint(personIndex) {
    trashPoints[personIndex]++;
    updatePointsDisplay();
    updateNextTrashPerson();
    
    if (database) {
        await saveToFirebase();
    }
    
    showSaveIndicator(`+1 punto spazzatura per ${settings.names[personIndex]}! 🗑️`);
}

async function removeTrashPoint(personIndex) {
    if (trashPoints[personIndex] > 0) {
        trashPoints[personIndex]--;
        updatePointsDisplay();
        updateNextTrashPerson();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator(`-1 punto spazzatura per ${settings.names[personIndex]} ❌`);
    }
}

async function resetTrashPoints() {
    if (confirm('Vuoi azzerare tutti i punti spazzatura?')) {
        trashPoints = [0, 0, 0, 0];
        updatePointsDisplay();
        updateNextTrashPerson();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Punti spazzatura azzerati! 🗑️');
    }
}

function updateNextTrashPerson() {
    const nextPersonElement = document.getElementById('nextTrashPerson');
    if (!nextPersonElement) return;
    
    const minPoints = Math.min(...trashPoints);
    const candidates = [];
    
    trashPoints.forEach((points, index) => {
        if (points === minPoints) {
            candidates.push(settings.names[index]);
        }
    });
    
    if (candidates.length === 1) {
        nextPersonElement.innerHTML = `
            <div class="next-person-card">
                <div class="next-person-icon">🗑️</div>
                <div class="next-person-text">
                    Prossimo turno spazzatura:<br>
                    <strong>${candidates[0]}</strong>
                </div>
            </div>
        `;
    } else {
        nextPersonElement.innerHTML = `
            <div class="next-person-card">
                <div class="next-person-icon">🗑️</div>
                <div class="next-person-text">
                    Candidati per il prossimo turno:<br>
                    <strong>${candidates.join(', ')}</strong>
                </div>
            </div>
        `;
    }
}

// ================================
// SISTEMA PUNTI SPESA
// ================================

function updateShoppingPointsDisplay() {
    const container = document.getElementById('shoppingPointsContainer');
    if (!container) return;
    
    // Crea array con indici e punti per ordinamento
    const peopleWithPoints = settings.names.map((name, index) => ({
        name,
        index,
        points: shoppingPoints[index]
    }));
    
    // Ordina per punti crescenti (meno punti = più priorità)
    peopleWithPoints.sort((a, b) => a.points - b.points);
    
    container.innerHTML = peopleWithPoints.map(person => `
        <div class="points-card">
            <div class="person-name">${person.name}</div>
            <div class="points-value">${person.points} punti</div>
            <div class="points-buttons">
                <button onclick="addShoppingPoint(${person.index})" class="btn-point add">+1</button>
                <button onclick="removeShoppingPoint(${person.index})" class="btn-point remove">-1</button>
            </div>
        </div>
    `).join('');
}

async function addShoppingPoint(personIndex) {
    shoppingPoints[personIndex]++;
    updateShoppingPointsDisplay();
    updateNextShoppingPerson();
    
    if (database) {
        await saveToFirebase();
    }
    
    showSaveIndicator(`+1 punto spesa per ${settings.names[personIndex]}! 🛒`);
}

async function removeShoppingPoint(personIndex) {
    if (shoppingPoints[personIndex] > 0) {
        shoppingPoints[personIndex]--;
        updateShoppingPointsDisplay();
        updateNextShoppingPerson();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator(`-1 punto spesa per ${settings.names[personIndex]} ❌`);
    }
}

async function resetShoppingPoints() {
    if (confirm('Vuoi azzerare tutti i punti spesa?')) {
        shoppingPoints = [0, 0, 0, 0];
        updateShoppingPointsDisplay();
        updateNextShoppingPerson();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Punti spesa azzerati! 🛒');
    }
}

function updateNextShoppingPerson() {
    const nextPersonElement = document.getElementById('nextShoppingPerson');
    if (!nextPersonElement) return;
    
    const minPoints = Math.min(...shoppingPoints);
    const candidates = [];
    
    shoppingPoints.forEach((points, index) => {
        if (points === minPoints) {
            candidates.push(settings.names[index]);
        }
    });
    
    if (candidates.length === 1) {
        nextPersonElement.innerHTML = `
            <div class="next-person-card">
                <div class="next-person-icon">🛒</div>
                <div class="next-person-text">
                    Prossimo turno spesa:<br>
                    <strong>${candidates[0]}</strong>
                </div>
            </div>
        `;
    } else {
        nextPersonElement.innerHTML = `
            <div class="next-person-card">
                <div class="next-person-icon">🛒</div>
                <div class="next-person-text">
                    Candidati per il prossimo turno:<br>
                    <strong>${candidates.join(', ')}</strong>
                </div>
            </div>
        `;
    }
}

// ================================
// LISTA SPESA
// ================================

function updateShoppingList() {
    const container = document.getElementById('shoppingListContainer');
    if (!container) return;
    
    container.innerHTML = `
        <div class="shopping-input-container">
            <input type="text" id="newShoppingItem" placeholder="Aggiungi elemento alla lista..." onkeypress="if(event.key==='Enter') addShoppingItem()">
            <button onclick="addShoppingItem()" class="btn-add-item">Aggiungi</button>
        </div>
        <div class="shopping-items">
            ${shoppingList.map((item, index) => `
                <div class="shopping-item ${item.completed ? 'completed' : ''}">
                    <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="toggleShoppingItem(${index})">
                    <span class="item-text">${item.text}</span>
                    <button onclick="removeShoppingItem(${index})" class="btn-remove-item">🗑️</button>
                </div>
            `).join('')}
        </div>
        ${shoppingList.length === 0 ? '<div class="empty-list">Nessun elemento nella lista</div>' : ''}
    `;
}

async function addShoppingItem() {
    const input = document.getElementById('newShoppingItem');
    const text = input.value.trim();
    
    if (text) {
        shoppingList.push({
            text: text,
            completed: false,
            addedAt: new Date().toISOString()
        });
        
        input.value = '';
        updateShoppingList();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator(`Aggiunto: ${text} 🛒`);
    }
}

async function toggleShoppingItem(index) {
    if (shoppingList[index]) {
        shoppingList[index].completed = !shoppingList[index].completed;
        updateShoppingList();
        
        if (database) {
            await saveToFirebase();
        }
    }
}

async function removeShoppingItem(index) {
    if (shoppingList[index]) {
        const itemText = shoppingList[index].text;
        shoppingList.splice(index, 1);
        updateShoppingList();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator(`Rimosso: ${itemText} ❌`);
    }
}

async function clearCompletedItems() {
    const completedCount = shoppingList.filter(item => item.completed).length;
    
    if (completedCount > 0 && confirm(`Vuoi rimuovere ${completedCount} elementi completati?`)) {
        shoppingList = shoppingList.filter(item => !item.completed);
        updateShoppingList();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator(`${completedCount} elementi rimossi! ✅`);
    }
}

// ================================
// FUNZIONI UTILITY
// ================================

function showSaveIndicator(message) {
    const indicator = document.getElementById('saveIndicator');
    if (indicator) {
        indicator.textContent = message;
        indicator.style.display = 'block';
        indicator.style.opacity = '1';
        
        setTimeout(() => {
            indicator.style.opacity = '0';
            setTimeout(() => {
                indicator.style.display = 'none';
            }, 300);
        }, 2000);
    }
}

function updateAllInterface() {
    renderSchedule();
    updateSettings();
    updatePointsDisplay();
    updateNextTrashPerson();
    updateShoppingPointsDisplay();
    updateNextShoppingPerson();
    updateShoppingList();
    updateWeekDates();
    document.getElementById('weekNumber').textContent = currentWeek;
    loadRestrictions();
    
    // AGGIUNGI QUESTA RIGA:
    renderCustomRotationsEditor();
}

// ================================
// INIZIALIZZAZIONE
// ================================

document.addEventListener('DOMContentLoaded', function() {
    // Imposta settimana corrente
    currentWeek = getCurrentWeekOfYear();
    
    // Popola campo Firebase URL
    const firebaseInput = document.getElementById('firebaseUrl');
    if (firebaseInput && firebaseUrl) {
        firebaseInput.value = firebaseUrl;
    }
    
    // Inizializza Firebase
    initializeFirebase();
    
    // Aggiorna interfaccia
    updateAllInterface();
    
    // Attiva tab calendario per default
    const calendarioTab = document.querySelector('[onclick="showTab(\'calendario\')"]');
    if (calendarioTab) {
        calendarioTab.classList.add('active');
        document.getElementById('calendario').classList.add('active');
    }
    
    console.log('🏠 Calendario Pulizie Casa v3.0 inizializzato');
});
// Funzione per rigenerare le turnazioni mantenendo le restrizioni
async function regenerateRotations() {
    if (confirm('Vuoi rigenerare le turnazioni con le restrizioni attuali? Questo risolverà i problemi di assegnazione.')) {
        // Reset degli stati
        alternationState = {
            bagno1: { lastPerson: -1, cycle: [] },
            bagno2: { lastPerson: -1, cycle: [] }
        };
        
        skippedAssignments = {};
        
        // Rigenera rotazioni
        const newRotations = generateValidRotations();
        
        // Valida le rotazioni generate
        const validation = validateRotations(newRotations);
        
        if (validation.isValid) {
            rotation = newRotations;
            renderSchedule();
            
            if (database) {
                await saveToFirebase();
            }
            
            showSaveIndicator('Turnazioni rigenerate correttamente! ✅');
        } else {
            // Mostra errori ma applica comunque (è meglio che niente)
            rotation = newRotations;
            renderSchedule();
            
            if (database) {
                await saveToFirebase();
            }
            
            showSaveIndicator('Turnazioni rigenerate con alcuni avvisi (vedi console) ⚠️');
            console.warn('Turnazioni generate con conflitti:', validation.errors);
        }
    }
}

// Funzione per reset completo delle turnazioni
async function resetRotations() {
    if (confirm('ATTENZIONE: Questo resetterà completamente tutte le turnazioni e le restrizioni. Continuare?')) {
        // Reset restrizioni a default (tutti possono pulire tutto)
        cleaningRestrictions.bagno1 = [0, 1, 2, 3];
        cleaningRestrictions.bagno2 = [0, 1, 2, 3];
        cleaningRestrictions.cucina = [0, 1, 2, 3];
        
        // Reset stati
        alternationState = {
            bagno1: { lastPerson: -1, cycle: [] },
            bagno2: { lastPerson: -1, cycle: [] }
        };
        
        skippedAssignments = {};
        
        // Reset rotazioni personalizzate
        customRotations = {
            enabled: false,
            weeks: {}
        };
        
        // Rigenera rotazioni di default
        rotation = {
            bagno1: [1, 2, 3, 4],
            bagno2: [2, 3, 4, 1],
            cucina: [3, 4, 1, 2]
        };
        
        // Aggiorna tutto
        updateRestrictionsDisplay();
        renderSchedule();
        renderCustomRotationsEditor();
        
        if (database) {
            await saveToFirebase();
        }
        
        showSaveIndicator('Reset completo eseguito! Tutte le turnazioni sono state ripristinate. ⚠️');
    }
}