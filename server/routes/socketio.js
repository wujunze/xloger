
var reportServers = {};

var cookie = require("cookie")
,   session = require("express-session")
,   fs = require('fs')
,   os = require('os')
,   path = require('path')
,   moment = require('moment')
,   extend = require('util')._extend
,   config = global.config
,   redisConfig = global.redisConfig
;




/**
 * All socket IO events that can be emitted by the client
 * @param {[type]} socket [description]
 */
exports.SocketOnConnection = function(socket) {

	var handshake = socket.handshake
	,	sessionID = handshake.sessionID
	,	meetingID = handshake.meetingID
	;

    // parse cookies
    handshake.cookies = cookie.parse(handshake.headers.cookie);
    handshake.filter = {};

    socket.join( "web" );

    updateRedisFilter();

    socket.emit('connected', { address: handshake.address, reportors:reportServers, filter:handshake.filter } );

    // 筛选
    socket.on("filter",function(fltstr){
        var filter = fltstr.split(":");
        var field = '';
        switch(filter[0].toLowerCase())
        {
            case "serverip": field="serverIP"; break;
            case "clientip": field="clientIP"; break;
            case "useragent": field="userAgent"; break;
            case "host": field= "host"; break;
            case "httpmethod": field="httpMethod"; break;
            case "requesturi": field="requestURI";break;

            case "cookie":
                if(!handshake.filter.cookies) handshake.filter.cookies = {};
                var cookiesp = filter[1].split("=");
                handshake.filter.cookies[cookiesp[0]]=cookiesp[1];
                break;
        }

        if(field) handshake.filter[field] = filter[1];
        socket.emit("updateFilter", handshake.filter );
        updateRedisFilter();
    });


    /** 断开来连接 */
    socket.on('disconnect', function () {

    });
  
};


function updateRedisFilter(){
    var filters = []; // 全局filter
    // 遍历客户端, 合并filter
    io.to("web").sockets.forEach(function(socket, i){
        filters.push( socket.handshake.filter );
    });
    redisConfig.filters = filters;
    redisClient.set( config["redisConfigName"], JSON.stringify(redisConfig) );
}



var tCache = {
    threads:{},
    dispose:function(data){
        switch(data.type.toLowerCase()){
            case "threadstart":
                this.threads[data.thread] = {
                    // 3分钟过期
                    expired: (+new Date)+(1000*60*3),
                    tid: data.thread,
                    data: data
                };
                break;
                // 结束
            case "threadend":
                this.threads[data.thread] && delete this.threads[data.thread];
                break;
        }
    },
    get:function(tid){
        if(this.threads[tid]){
            return this.threads[tid].data;
        }
        return null;
    },
    _tm:null,
    expiredCleaning:function(){
        var t = this, now = +new Date;
        var th;
        for(var tid in t.threads){
            th =  t.threads[tid];
            if(th.expired && th.expired< now){
                delete t.threads[th.tid];
            }
        }

        clearTimeout(t._tm);
        t._tm = setTimeout(function(){
            t.expiredCleaning();
        }, 1000*60*3 );
    }
};
// 启动定时清理
tCache.expiredCleaning();


function dispatchFilter(socket, data){
    var filter = socket.handshake.filter;
    // 保存线程记录
    if(!socket.handshake.threads) socket.handshake.threads = {};
    // 已筛选通过的线程
    var threads = data.thread.split("_"), thread_exists = false;
    // 结束进程或子进程
    threads.forEach(function(t, i){
        var tid = threads.slice(0,i+1).join("_");
        if( socket.handshake.threads[tid] ){ // 存在进程或父进程记录
            // 线程结束信号
            if(data.type.toLowerCase()=="threadend"){
                delete socket.handshake.threads[data.thread];
            } 
            thread_exists = true;
            return false;
        }
    });
    // 子进程, 无需筛选
    if(thread_exists) return true;

    var hasfilter = false;
    var dcookies = cookie.parse(typeof data.cookie=="string"?data.cookie:"");
    for(var p in filter){
        hasfilter = true;
        switch(p){
            case "cookies":
                for(var c in filter.cookies){
                    if( !(new RegExp(filter.cookies[c])).test(dcookies[c]) ) return false;
                }
                break;
            default:
                if( !(new RegExp(filter[p])).test(data[p]) ) return false;
        }
    }
    // 无筛选条件
    if(!hasfilter) return false;

    // 移除过期进程
    var thread, now = +new Date;
    for(var tid in socket.handshake.threads){
        thread =  socket.handshake.threads[tid];
        if(thread && thread.expired && thread.expired< now){
            delete socket.handshake.threads[tid];
        }
    }

    // 保存筛选通过的线程
    if(data.type.toLowerCase() == "threadstart"){
        socket.handshake.threads[data.thread] = {
            // 3分钟过期
            expired: (+new Date)+(1000*60*3)
        };
    }

    return true;
}


function webPublish (action, data){
    data.timestamp = data.timestamp || (+new Date()/1000),
    data.fire = JSON.parse(data.fire||"null");
    // 遍历客户端, 根据filter发送消息
    io.to("web").sockets.forEach(function(socket, i){
        if( dispatchFilter(socket, data) ){
            socket.emit(action, data );
        }
    });

    // 写日志
    writeLog(action, data );
    
    // 缓存进程数据
    tCache.dispose(data);
    //io.to("web").emit( action, data );
}
exports.webPublish = webPublish;

/**
 * 日志采集到文件
 */
function writeLog(action, data){

    if(action!="log") return;
    if(!data.fire) return;

    if(!data.serverIP){ // 无线程监控信息
        var th = tCache.get(data.thread);
        if(th){
            var o = extend({},th);
            data = extend(o, data);
        }
    }
    var date = moment().format('YYYYMMDD');
    var dir  = data.serverIP ? path.join(config.logdir, data.serverIP, date):  path.join(config.logdir, date);
    if(!fs.existsSync(dir)){
        fs.mkdirSync(dir, 755); // 创建目录
    }

    var logconf = config.logger || {
            ignoreHosts:{
                all:[],
                error:[],
                warning:[],
                notice:[]
            }
        };

    // 日志过滤配置
    if(logconf.ignoreHosts.all.indexOf(data.host.toLowerCase())>=0) return;

    var filename = "", type="Unknown";
    switch(data.type.toLowerCase()){
        case "filelog":
            type = "FileLog";
            filename = path.join( dir, data.fire.args[0] );
            break;
        case "error":
        case "cerror":
            if(logconf.ignoreHosts.error.indexOf(data.host.toLowerCase())>=0) return;
            type = "Error";
            filename = path.join( dir, "error.log" );
            break;
        case "sqlerror":
            type = "SqlError";
            filename = path.join( dir, "sql-error.log" );
            break;
        case "warning":
        case "cwarning":
            if(logconf.ignoreHosts.warning.indexOf(data.host.toLowerCase())>=0) return;
            type = "Warning";
            filename = path.join( dir, "warning.log" );
            break;
        case "notice":
        case "cnotice":
            if(logconf.ignoreHosts.notice.indexOf(data.host.toLowerCase())>=0) return;
            type = "Notice";
            filename = path.join( dir, "notice.log" );
            break;
        default:
            return;
    }

    // 日志格式
    var logstr = [
            '[{datetime}] [{type}] {fire.message} on {fire.file} in line {fire.line} ',
            '-- {method} {host}{uri}{post} "{ua}" {cip}'
        ].join('').format({
        type: type,
        datetime: moment().format('DD/MMM/YYYY:HH:mm:ss ZZ'),
        fire: data.fire,
        sip: data.serverIP,
        cip: data.clientIP,
        method: data.httpMethod,
        host: data.host,
        ua: data.userAgent,
        uri: data.requestURI,
        post: (data.httpMethod.toLowerCase()=="post" && data.postData)?(["[DATA[","]]"].join(data.postData)):''
    })+os.EOL+os.EOL;

    if(type=="FileLog"){
        var args = data.fire.args.slice(1).map(function(arg, i){
            return JSON.stringify(arg);
        }).join(os.EOL)
    }

    fs.appendFileSync(filename, logstr, {flags:"a+"});

}


// 收到服务器推送过来的消息
exports.onConsoleMessage =  function (channel, message) {
    message = JSON.parse(message);

    if(channel == "console-log"){
        webPublish("log", message );
    }

    if(channel == "console-server-reg"){
        var serverip = message.ip;
        var server = reportServers[serverip];
        if(!server){
            server = reportServers[serverip] = {
                serverip: serverip,
                hosts:[]
            };
        }
        // 保存服务器所绑定的host
        if(message.host && message.host!="unknown" && server.hosts.indexOf(message.host)<0 ){
            server.hosts.push(message.host)
        }
        redisConfig.reportServers = reportServers;
    }
}

