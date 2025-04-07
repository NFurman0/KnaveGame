//setup for express and socket.io
const express = require('express');
const app = express();

const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {pingInterval: 2000, pingTimeout: 15000});
const port = 3000;
const playersPerRoom = 5;

const SUITS = ["Clubs", "Diamonds", "Hearts", "Spades"];
const PRIMES = [2, 3, 5, 7, 11];
class PlayingCard {
    constructor(suit, value) {
        this.suit = suit;
        this.value = value;
    }
}

function SHUFFLE_ARRAY(a) {
    for(var i = a.length - 1; i > 0; i--) {
        const swapIndex = Math.floor(Math.random() * (i+1));
        [a[i], a[swapIndex]] = [a[swapIndex], a[i]]; //swaps the elements at i and swapIndex
    }
}

class Roles_Deck {
    constructor() {
        this.roles = [];
        if(playersPerRoom === 5) {
            for(const suit of SUITS) {
                this.roles.push(new PlayingCard(suit, "Jack"));
            }
            this.roles.push(new PlayingCard("Joker", "Joker"));
        } else {
            console.log(playersPerRoom + " functionality not yet programmed.");
        }
        SHUFFLE_ARRAY(this.roles);
    }
}

class Cards_Deck {
    constructor() {
        this.cards = [];
        for(const suit of SUITS) {
            for(var i = 2; i <= 11; i++) {
                this.cards.push(new PlayingCard(suit, i));
            }
        }
        SHUFFLE_ARRAY(this.cards);
    }
}

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

//removes certain characters to protect against xss
function validateInput(inp) {
    return inp.replace(/[&<>'"]/g, (m) => {
        return "&#" + m.charCodeAt(0) + ";";
    });
}

//adds the socket with the given id to the specified room.
function addToRoom(id, room, updatePlayers) {
    room = String(room); //room int 0 and room string 0 are different in sockets.io
    const relevantSocket = io.sockets.sockets.get(id);
    relevantSocket.join(room);

    const pNum = rooms[room]["numPlayers"]; //note: pNum goes from 0 to PlayersPerRoom - 1, not 1 to PlayersPerRoom
    rooms[room]["numPlayers"] += 1;

    //First try to add them to an empty slot
    var tookEmptySlot = false;
    const roomSlots = rooms[room]["roomSlots"];
    for(const slot in roomSlots) {
        if(roomSlots[slot]["id"] === "_") {
            addToRoomSlot(id, room, slot)
            tookEmptySlot = true;
            //if the game has already started, send them the role and cards associated with this slot
            if(roomSlots[slot]["role"]) {
                const pSocket = io.sockets.sockets.get(id);
                pSocket.emit("GameStart", roomSlots[slot]["role"]);
            }
            break;
        }
    }
    if(!tookEmptySlot) { //otherwise create a new slot for them
        addToRoomSlot(id, room, pNum);
    }

    players[id]["actualRoom"] = room;

    if(updatePlayers) updateRoomPlayers(room);
}

//creates a room slot or adds player to existing room slot
function addToRoomSlot(id, room, slot) {
    if(!rooms[room]["roomSlots"][slot]) {
        rooms[room]["roomSlots"][slot] = {};
        rooms[room]["roomSlots"][slot]["ready_status"] = false;
    }
    rooms[room]["roomSlots"][slot]["id"] = id;
    players[id]["roomSlot"] = slot;
}

function checkReadyPlayers(roomNum) {
    const slots = rooms[roomNum]["roomSlots"];
    var numReady = 0;
    var totalPlayers = 0;

    for(const slot in slots) {
        if(slots[slot]["ready_status"]) numReady += 1;
        totalPlayers += 1;
    }

    io.to(roomNum).emit("NumberOfReadyPlayers", numReady);
    return (numReady >= totalPlayers);
}

//sends all players in a room the list of usernames of players in that room. Determining who joined/left is done client side.
function updateRoomPlayers(room) {
    room = String(room);
    var userNamesList = [];
    const slots = rooms[room]["roomSlots"];

    for(const slot in slots) {
        if(slots[slot]["id"] !== "_") userNamesList.push(players[slots[slot]["id"]]["username"]);
    }
    io.to(room).emit("UpdatePlayers", userNamesList);
    checkReadyPlayers(room);
}

function closeRoom(room) {
    console.log("attempting to close " + room);

    const slots = rooms[room]["roomSlots"];
    for(const slot in slots) {
        if(slots[slot]["id"] === "_") continue;

        const id = slots[slot]["id"];

        if(players[id]["actualRoom"] == room) {
            players[id]["actualRoom"] = "";
            players[id]["requestedRoom"] = "";
        }

        const sock = io.sockets.sockets.get(id);
        if(!sock) continue;

        sock.leave(room);
    }
    delete roomRequests[rooms[room]["requestedRoomID"]]["successfulRooms"][room];
    delete rooms[room];

    console.log("successfully closed " + room);
}

function runTurn(room) {
    const numPlayers = 5; //again
    const currentTurn = rooms[room]["currentTurn"];
    const activePlayer = rooms[room]["activePlayer"];

    if(currentTurn >= numPlayers) {
        endRound(room);
    }
    else {
        const slot = rooms[room]["roomSlots"][activePlayer];
        const hand = slot["deck"].slice(0, 3);
        SHUFFLE_ARRAY(rooms[room]["playedCards"]);

        io.to(room).emit("TurnIsOccurring", activePlayer);
        io.to(slot["id"]).emit("TakeTurn", hand, rooms[room]["playedCards"]);
    }
}

function startRound(room) {
    const currentRound = rooms[room]["currentRound"];
    const attackers = rooms[room]["attackDeck"].slice(currentRound*2, currentRound*2+2);
    rooms[room]["currentTurn"] = 0;
    rooms[room]["activePlayer"] = (4*rooms[room]["phase"] + currentRound - 5)%5; //a lot to change for different pNums

    io.to(room).emit("RoundStart", attackers);
    rooms[room]["playedCards"] = [];
    runTurn(room); //after this runTurn is called on player responses
}

function endRound(room) {
    const currentRound = rooms[room]["currentRound"];
    const attackers = rooms[room]["attackDeck"].slice(currentRound*2, currentRound*2+2);

    const attackScore = 3*attackers[0].value + attackers[1].value;
    const playedCards = rooms[room]["playedCards"];

    var sum = 0;
    var suitMatch = false;
    var prime = false;
    for(const card of playedCards) {
        sum += card.value;
        if(PRIMES.includes(card.value)) prime = true;
        if(attackers[1].suit === card.suit) suitMatch = true;
    }
    if(sum > attackScore && suitMatch && prime) {
        io.to(room).emit("RoundEnd", true, playedCards);
    }
    else {
        io.to(room).emit("RoundEnd", false, playedCards);
        rooms[room]["assassinations"] += 1;
        if(rooms[room]["assassinations"] >= 4) endGame(room);
    }

    if(currentRound >= 4) { //4 rounds in a phase
        endPhase(room);
    }
    else {
        rooms[room]["currentRound"] += 1;
        startRound(room);
    }
}

function startPhase(room) {
    const deck = new Cards_Deck();
    const numPlayers = 5; //change so different player numbers can work
    const slots = rooms[room]["roomSlots"];

    for(var i = 0; i < numPlayers; i++) {
        const slotDeck = deck.cards.slice(i*6, i*6+6);
        slots[i]["deck"] = slotDeck;
    }

    rooms[room]["attackDeck"] = deck.cards.slice(numPlayers*6);
    rooms[room]["currentRound"] = 1;
    rooms[room]["phase"] += 1;

    startRound(room);
}

function endPhase(room) {
    const phase = rooms[room]["phase"];

    if(phase === 1) {
        startPhase(room);
    } else {
        endGame(room);
    }
}

function startGame(room) {
    const roles = new Roles_Deck();
    const roomSlots = rooms[room]["roomSlots"];
    for(var slot in roomSlots) {
        const pID = roomSlots[slot]["id"];
        const pSocket = io.sockets.sockets.get(pID);
        const role = roles.roles[parseInt(slot)];

        roomSlots[slot]["role"] = role;
        pSocket.emit("GameStart", role);
        if(role.suit.includes("Joker")) rooms[room]["knaveSlot"] = slot;
    }
    rooms[room]["phase"] = 0;
    rooms[room]["assassinations"] = 0;

    startPhase(room);
}

function endGame(room) {
    console.log("ending game in room " + room);

    var numA = rooms[room]["assassinations"];
    io.to(room).emit("endGame", numA);
    if(numA != 3) {
        //either knights or knaves won outright, no need for voting
        //rooms should close after 10 seconds
        setTimeout(() => {
            closeRoom(room);
        }, 10000);
    } 
    else {
        //voting will occur
        rooms[room]["votes"] = [];
        for(slot in rooms[room]["roomSlots"]) rooms[room]["roomSlots"][slot]["hasVoted"] = false;
    }
}

function countVote(room, vote) {
    const voteArray = rooms[room]["votes"];
    voteArray.push(vote); //votes should be a slot number

    if(voteArray.length >= rooms[room]["numPlayers"]) {
        const knaveSlot = rooms[room]["knaveSlot"];
        const roomSlots = rooms[room]["roomSlots"];

        for(vote of voteArray) {
            if(roomSlots[vote]["voteTally"]) roomSlots[vote]["voteTally"] += 1;
            else roomSlots[vote]["voteTally"] = 1;
        }
        const knaveVotes = roomSlots[knaveSlot]["voteTally"];

        var knaveWins = true;
        
        for(slot in roomSlots) {
            if(roomSlots[slot]["voteTally"] >= knaveVotes) {
                knaveWins = false;
                break;
            }
        }

        io.to(room).emit("endVoting", knaveSlot, knaveWins);

        setTimeout(() => {
            closeRoom(room);
        }, 10000);
    }
}

//holds a socket id as a key, with a value object that holds player data
//players[socket.id] has properties username, requestedRoom, actualRoom (if found), and roomSlot (if found).
const players = {};

//holds the players waiting to get into a given room. The user inputted room id is the key, so
//roomRequests[UserRoom] is an object with socket ids as keys, and true as value (object used over array for easier insertion/deletion)
const roomRequests = {};

//holds all the currently active rooms, keys will be from currentRoom (0, 1, 2...), values will be objects
//Contains numPlayers, requestedRoomID, phase (integer), assassinations (integer), votes (array, only exists during vote tally),
// currentRound (integer), attackDeck (array of Card Objects), currentTurn (integer), activePlayer (integer representing slot number),
// playedCards (array of Card Objects), knaveSlot (integer), and roomSlots (object of objects specified below).
//rooms[room]["roomSlots"][slotNumber] holds info for each player: ready_status (boolean), deck (array of Card objects),
// role (card Object), and id (string).
const rooms = {};
//currentRoom ensures multiple rooms can have the same inputted room code.
var currentRoom = 0;

//when a new user connects to the server, this runs for their socket.
io.on("connection", (socket) => {
    players[socket.id] = {}; //document the player

    //when the socket disconnects from the server
    socket.on("disconnect", (reason) => {
        //get the room the dc'd player was in, if any
        var dcRoom = players[socket.id]["actualRoom"];
        if(rooms[dcRoom]) {
            rooms[dcRoom]["roomSlots"][players[socket.id]["roomSlot"]]["id"] = "_"; //Free their room slot
            rooms[dcRoom]["roomSlots"][players[socket.id]["roomSlot"]]["ready_status"] = false; //reset their ready status.
            rooms[dcRoom]["numPlayers"] -= 1; //update the player count

            if(rooms[dcRoom]["numPlayers"] <= 0) {
                closeRoom(dcRoom)
            }
            else {
                updateRoomPlayers(dcRoom);//tell the remaining players the updated player list
            }
        }
        
        //get the room they were requesting if they dc'd while searching, and remove them from that request list
        var dcRequest = players[socket.id]["requestedRoom"];
        if(roomRequests[dcRequest]) {
            delete roomRequests[dcRequest][socket.id];
        }

        //remove them from players
        delete players[socket.id];
    });
    
    //players will ping the server for a Check In event when moving to the Game_Found page
    //this code will add them to the waiting list for their requested room, and create the room if enough people are waiting
    socket.on("CheckIn", (UserName, UserRoom) => {
        UserName = validateInput(UserName);
        UserRoom = validateInput(UserRoom); //sanitize username and room request
        players[socket.id]["username"] = UserName;
        players[socket.id]["requestedRoom"] = UserRoom;

        //If that request is new create the roomReq object
        if(!roomRequests[UserRoom]) {
            roomRequests[UserRoom] = { successfulRooms: {} }; //only 15 characters so no incredibly funny socket id collisions, sadly
            roomRequests[UserRoom][socket.id] = true;
            return; //the rest of the code need not be executed if only 1 player is in line
        }

        //first try to add player to existing room:
        for(const rID in roomRequests[UserRoom]["successfulRooms"]) {
            if(rooms[rID]["numPlayers"] < playersPerRoom) {
                addToRoom(socket.id, rID, true);
                return;
            }
        }

        roomRequests[UserRoom][socket.id] = true; //add the player to the waiting list for the input ID
        //this code then tries to create a new room for the requested room id, if there's enough people in line.
        var waitingList = [];
        for(const id in roomRequests[UserRoom]) {
            if(id == "successfulRooms") continue; //not a player id >:(
            waitingList.push(id);

            if(waitingList.length === playersPerRoom) {
                rooms[currentRoom] = {};
                rooms[currentRoom]["numPlayers"] = 0;
                rooms[currentRoom]["roomSlots"] = {};

                for(const user of waitingList) {
                    addToRoom(user, currentRoom, false);
                    delete roomRequests[UserRoom][user]; //no longer in line
                }
                //Used when deleting the room, so it can be removed from roomReqs
                rooms[currentRoom]["requestedRoomID"] = UserRoom; 
                //add the successful room to the roomRequests so more players can join if players leave
                roomRequests[UserRoom]["successfulRooms"][currentRoom] = true;

                updateRoomPlayers(currentRoom);

                currentRoom += 1;
                waitingList = [];
            }
        }
    });

    //When players send a message they will emit this event for us to emit to the rest of the room.
    socket.on("Message_Send", (text) => {
        if(!players[socket.id]["actualRoom"]) return;
        text = validateInput(text);
        io.to(players[socket.id]["actualRoom"]).emit("Message_Recieve", players[socket.id]["username"], text);
    });

    socket.on("PlayerReadyStateChange", (state) => {
        if(!players[socket.id]["actualRoom"]) return;
        const roomNum = players[socket.id]["actualRoom"];
        const room = rooms[roomNum];
        const playerSlot = players[socket.id]["roomSlot"];

        room["roomSlots"][playerSlot]["ready_status"] = (state === "Ready");

        if(checkReadyPlayers(roomNum)) startGame(roomNum);
    });

    socket.on("PlayerCardChoice", (choice) => {
        if(choice !== 0 && choice !== 1 && choice !== 2) return; //invalid choice

        const room = rooms[players[socket.id]["actualRoom"]];
        if(!room) return; //not in a room yet
        
        const slot = players[socket.id]["roomSlot"];
        if(room["activePlayer"] != slot) return; //not their turn yet

        const deck = room["roomSlots"][slot]["deck"];
        const cardChoice = deck[choice];
        deck.splice(choice, 1);

        room["playedCards"].push(cardChoice);

        room["currentTurn"] += 1;
        room["activePlayer"] = (room["activePlayer"]+1)%5; //again
        runTurn(players[socket.id]["actualRoom"]);
    });

    socket.on("Player_Vote", (vote) => {
        const room = players[socket.id]["actualRoom"];
        const slotVotedFor = rooms[room]["roomSlots"][vote]
        if(!slotVotedFor) return;

        const senderSlot = players[socket.id]["roomSlot"];
        if(rooms[room]["roomSlots"][senderSlot]["hasVoted"]) return; //prevent voting multiple times
        else rooms[room]["roomSlots"][senderSlot]["hasVoted"] = true;

        io.to(room).emit("Message_Recieve", players[socket.id]["username"], "Voted for " + players[slotVotedFor["id"]]["username"] + ".");
        countVote(room, vote);
    });
});

server.listen(port, () => {
    console.log("Listening on port " + port);
});
