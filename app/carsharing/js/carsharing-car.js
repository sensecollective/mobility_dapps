const series = require('async/series');
const ethjsUtil = require('ethereumjs-util');
const mqttt = require('mqttt');
const util = require('util');

const common = require('../../common/js/app-common.js');
const utils = require('../../common/js/app-utils');
const CarService = require('../../car/js/car-service');
const carconfig = require('./car-config');

/**
 * The CarSharing class.
 * @constructor
 */
function CarSharing(carInfo) {
    var self = this;
    self.CAR_MSG_TTV = 1000*60*60;
    self.carInfo = carInfo;
}

/**
 * Dispatch MQTT topic handler.
 * @param {String} The topic.
 * @param {Buffer} The message buffer.
 */
CarSharing.prototype._mqttMsgDispatch = function (topic, msg) {
    var self = this;
    switch(topic) {
        case common.MQTTTopics.CAR_COMMANDS_CARSHARING:
            self.processCarCommand(msg);
            break;
        default:
            console.log('Unable to process topic ', topic);
    }
}

/**
 * Initialize and startup car service.
 * @param {String} The name of the blockchain rpc service. It supports 'testrpc'
 *      'infura' and 'geth'.
 * @param callback The function to be called when finish.
 */
CarSharing.prototype.bootup = function(rpcName, callback) {
    var self = this;
    series([     
        (cb) => {
            utils.bootstrapWeb3Account(rpcName, 'car', common.hdconfig, 
                    (web3, account) => {
                self.web3 = web3;
                self._account = account;
                cb();
            });
        },
        (cb) => {
            let artifacts = common.Artifacts.CarSharing;
            utils.bootstrapContract(self.web3.currentProvider, artifacts, (instance) => {
                self.carsharingIns = instance;       
                cb();
            });
        },
        (cb) => {
            self.car = new CarService();
            self.car.startIpfsApi({host: 'localhost', port: '5001', protocol: 'http'}, cb);
        },
        (cb) => self.car.listenCarTopic('MQTT', common.MQTTTopics.CAR_COMMANDS_CARSHARING, 
                (topic, msg) => {
            self._mqttMsgDispatch(topic, msg);
        }, cb),
        
    ], (err) => {
        if (err) {
            return console.log('\n', err);
        }
        console.log('\nCarSharing Dapp [car] node booted!');
        if (callback) callback();
    });
}

/**
 * Update car data periodically to ipfs/ car ipns.
 */
CarSharing.prototype.updateCarProfile = function() {
    var self = this;
    var profile = {
        info: self.carInfo,
        loc: self.car.loc,
        speed: self.car.speed,
        locked: self.car.locked
    } 
    //console.log(profile);
    self.car.ipfsNode.files.add([ {
        path: '/tmp/profile.txt',
        content: new Buffer(JSON.stringify(profile))
    }], (err, res) => {
        if (err) throw err;
        for(var i = 0; i < res.length; i++) {
            if (res[i].path === '/tmp/profile.txt') {
                self.car.ipfsNode.name.publish(res[i].hash, (err, res) => {
                    if (err) throw err;
                });
                return;
            }
        }
    });
}

/**
 *  Start car data update timer/service.
 */
CarSharing.prototype.startProfileUpdateTimer = function() {
    var self = this;
    self.profileUpdateTimer = setInterval(() => {
        self.updateCarProfile();
    }, 1000*30);
}

CarSharing.prototype.shutdown = function () {
    var self = this;
    self.car.stopService();
}

/**
 * Process raw car command with mqttt pre-process and verification.
 *
 * It handles three kinds of messages: unsigned raw message, MyEtherWallet signed 
 * and dated message format, and Oaken signed and dated message format.
 * Will be deprecated by mqttt after testing finishes.
 *
 * @param msg The message to be processed.
 */
CarSharing.prototype.processCarCommand = function (msg) {
    var self = this;
    var msg = msg.toString().trim();
    console.log('\nReceived new message: ', msg);
    if (msg === 'unlock' || msg === 'lock') {
        self.car.execCmd(msg);
        return;
    }

    if (typeof JSON.parse(msg).date === 'undefined') {
        var checked = utils.checkMyEtherWalletSignedMsg(msg, self.CAR_MSG_TTV);
    } else {
        var checked = utils.checkOakenSignedMsg(msg, self.CAR_MSG_TTV);
    }
    if (!checked.pass) return;

    // Check permission
    console.log('\n>> Checking user permission');
    self.carsharingIns.checkPermission2AccessCar.call(checked.address, 
            {from: self._account}).then((result) => {
        var err = result[0].toNumber();
        var permission = result[1].toNumber();
        err = 0;
        if (err !== 0) {
            console.log('Error checking permission, errno: ', err);
        } else {
            console.log('User permission code: ', permission);
            self.car.execCmd(checked.cmd);
        }
    });
}

/**
 * Start the MQTTT M2M communication service.
 * @param signer The data signer instance. For details about MQTTT signers, go 
 *      to https://github.com/shuangjj/mqttt.
 */
CarSharing.prototype.startMQTTT = function(signer) {
    var self = this;
    var mqtttClient = new mqttt.MQTTT(self._account, signer, 
            common.Configs.MQTT_Broker_TCP, 1000*60);
    mqtttClient.listen(true, (err, msg) => {
        if (err) throw err;
        switch(msg.type) {
            case 'request':
                self.processRequest(msg); 
                break;
            case 'response':
                break;
            case 'command':
                self.processCommand(msg);
                break;
            default:
                console.log(util.format('Unsupported mqttt message type %s', msg.type));
        }
    });
    self.mqtttClient = mqtttClient;
}

/**
 * Process 'request' typed message.
 * @param msg The message object.
 */
CarSharing.prototype.processRequest = function (msg) {
    var self = this;
    console.log('Processing request ' + msg.data);
    switch(msg.data) {
        case 'getprofile':
            var data = {
                info: self.carInfo,
            };
            self.mqtttClient.send(msg.from, JSON.stringify(data), 'response');
            break;
        case 'getstatus':
            var data = {
                loc: self.car.loc,
                speed: self.car.speed,
                locked: self.car.locked
            };
            self.mqtttClient.send(msg.from, JSON.stringify(data), 'response');
            break;
        default:
            console.log(util.format('Unsupported request type %s', msg.data));
    }
}

/**
 * Process MQTTT 'command' typed message.
 * @param msg The message packet object.
 */
CarSharing.prototype.processCommand = function (msg) {
    var self = this;
    console.log('Processing command ' + msg.data);
    switch (msg.data) {
        case 'unlock':
            var res = {
                err: null,
                result: 'unlocked'
            };
            self.car.execCmd('unlock');
            self.mqtttClient.send(msg.from, JSON.stringify(res), 'response');
            break;
        case 'lock':
            var res = {
                err: null,
                result: 'locked'
            };
            self.car.execCmd('lock');
            self.mqtttClient.send(msg.from, JSON.stringify(res), 'response');
            break;
        default:
            console.log(util.format('Unsupported command type %s', msg.data));
    }
}

// -$- Application starts here -$-
var csDapp = new CarSharing(carconfig['OakenTestCar']);
csDapp.bootup('geth', () => {
    csDapp.car.startGPSData();
    //var privkey = csDapp.web3.currentProvider.wallet.getPrivateKey();
    //var signer = new mqttt.signers.PrivKeySigner(privkey);
    var signer = new mqttt.signers.Web3Signer(csDapp.web3, 'nohash', 'hashPersonal');
    csDapp.startMQTTT(signer);
    csDapp.startProfileUpdateTimer();
});


