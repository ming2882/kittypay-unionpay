var md5 = require("md5");
var sha1 = require("sha1");
var request = require("request");
var _ = require("underscore");
var xml2js = require("xml2js");
var https = require("https");
var url_mod = require("url");

var signTypes = {
  MD5: md5,
  SHA1: sha1
};

var URLS = {
  GATEWAY: "https://qra.95516.com/pay/gateway",
  MICROPAY: "unified.trade.micropay", //被扫支付
  REVERSE: "unified.micropay.reverse", //被扫撤销订单
  QRPAY: "unified.trade.native", //扫码支付
  WXJSPAY: "pay.weixin.jspay", //微信公众号小程序支付
  ALIPAY_JSPAY: "pay.alipay.jspay", //支付宝服务窗支付
  ORDER_QUERY: "unified.trade.query", //查询订单--被扫支付可查询6次来确认
  CLOSE_ORDER: "unified.trade.close", //关闭订单--使用：扫码支付、微信公众号小程序支付、支付宝服务窗支付
  REFUND: "unified.trade.refund", //申请退款
  REFUND_QUERY: "unified.trade.refundquery" //退款查询
};

var Payment = function(config) {
  this.partnerKey = config.partnerKey;
  this.mchId = config.mchId;
  this.notifyUrl = config.notifyUrl;
  this.version = "2.0";
  this.charset = "UTF-8";
  this.sign_type = "MD5";
  return this;
};

Payment.prototype._httpRequest = function(url, data, callback) {
  request(
    {
      url: url,
      method: "POST",
      body: data
    },
    function(err, response, body) {
      if (err) {
        return callback(err);
      }

      callback(null, body);
    }
  );
};

Payment.prototype._signedQuery = function(service, params, options, callback) {
  var self = this;
  var required = options.required || [];

  if (service == URLS.REDPACK_SEND) {
    params = this._extendWithDefault(params, ["mch_id", "nonce_str"]);
  } else if (service == URLS.TRANSFERS) {
    params = this._extendWithDefault(params, ["nonce_str"]);
  } else {
    params = this._extendWithDefault(params, ["appid", "mch_id", "sub_mch_id", "nonce_str"]);
  }
  params.service = service;
  params = _.extend({ sign: this._getSign(params) }, params);

  for (var key in params) {
    if (params[key] !== undefined && params[key] !== null) {
      params[key] = params[key].toString();
    }
  }

  var missing = [];
  required.forEach(function(key) {
    var alters = key.split("|");
    for (var i = alters.length - 1; i >= 0; i--) {
      if (params[alters[i]]) {
        return;
      }
    }
    missing.push(key);
  });

  if (missing.length) {
    return callback("missing params " + missing.join(","));
  }

  var request = this._httpsRequest.bind(this);
  request(URLS.GATEWAY, this.buildXml(params), function(err, body) {
    if (err) {
      return callback(err);
    }
    self.validate(body, callback);
  });
};

Payment.prototype.getBrandWCPayRequestParams = function(order, callback) {
  var self = this;
  var default_params = {
    appId: this.appId,
    timeStamp: this._generateTimeStamp(),
    nonceStr: this._generateNonceStr(),
    signType: "MD5"
  };

  order = this._extendWithDefault(order, ["notify_url"]);

  this.unifiedOrder(order, function(err, data) {
    if (err) {
      return callback(err);
    }

    var params = _.extend(default_params, {
      package: "prepay_id=" + data.prepay_id
    });

    params.paySign = self._getSign(params);

    if (order.trade_type == "NATIVE") {
      params.code_url = data.code_url;
    } else if (order.trade_type == "MWEB") {
      params.mweb_url = data.mweb_url;
    }

    params.timestamp = params.timeStamp;

    callback(null, params);
  });
};

/**
 * 被扫支付
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.microPay = function(params, callback) {
  var requiredData = ["body", "out_trade_no", "total_fee", "mch_create_ip", "auth_code"];
  params.notify_url = params.notify_url || this.notifyUrl;
  this._signedQuery(URLS.MICROPAY, params, { required: requiredData }, callback);
};

/**
 * 被扫支付撤消订单
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.microReverse = function(params, callback) {
  var requiredData = ["out_trade_no"];
  params.notify_url = "";
  this._signedQuery(URLS.REVERSE, params, { required: requiredData }, callback);
};

/**
 * 扫码支付
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.microPay = function(params, callback) {
  var requiredData = ["body", "out_trade_no", "total_fee", "mch_create_ip"];
  params.notify_url = params.notify_url || this.notifyUrl;
  this._signedQuery(URLS.MICROPAY, params, { required: requiredData }, callback);
};

Payment.prototype.unifiedOrder = function(params, callback) {
  var requiredData = ["body", "out_trade_no", "total_fee", "spbill_create_ip", "trade_type"];
  if (params.trade_type == "JSAPI") {
    requiredData.push("openid|sub_openid");
  } else if (params.trade_type == "NATIVE") {
    requiredData.push("product_id");
  }
  params.notify_url = params.notify_url || this.notifyUrl;
  this._signedQuery(URLS.UNIFIED_ORDER, params, { required: requiredData }, callback);
};

/**
 * 订单查询：如果是被扫支付可查询6次来确认
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.orderQuery = function(params, callback) {
  this._signedQuery(
    URLS.ORDER_QUERY,
    params,
    {
      required: ["transaction_id|out_trade_no"]
    },
    callback
  );
};

/**
 * 申请退款
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.refund = function(params, callback) {
  params = this._extendWithDefault(params, ["op_user_id"]);

  this._signedQuery(
    URLS.REFUND,
    params,
    {
      https: true,
      required: ["transaction_id|out_trade_no", "out_refund_no", "total_fee", "refund_fee"]
    },
    callback
  );
};

/**
 * 退款查询
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.refundQuery = function(params, callback) {
  this._signedQuery(
    URLS.REFUND_QUERY,
    params,
    {
      required: ["transaction_id|out_trade_no|out_refund_no|refund_id"]
    },
    callback
  );
};

/**
 * 关闭订单：扫码支付、微信公众号小程序支付、支付宝服务窗支付
 * @param  {Object} params
 * @param  {Function} callback
 * @return {Object} object
 */
Payment.prototype.closeOrder = function(params, callback) {
  this._signedQuery(
    URLS.CLOSE_ORDER,
    params,
    {
      required: ["out_trade_no"]
    },
    callback
  );
};

Payment.prototype.buildXml = function(obj) {
  var builder = new xml2js.Builder({
    allowSurrogateChars: true
  });
  var xml = builder.buildObject({
    xml: obj
  });
  return xml;
};

Payment.prototype.validate = function(xml, callback) {
  var self = this;
  xml2js.parseString(xml, { trim: true, explicitArray: false }, function(err, json) {
    var error = null,
      data;
    if (err) {
      error = new Error();
      err.name = "XMLParseError";
      return callback(err, xml);
    }

    data = json ? json.xml : {};
    if (data.status != 0) {
      error = new Error(data.message ? data.message : "通信失败");
      error.name = "NetworkError";
    } else {
      if (data.return_code != 0) {
        error = new Error(data.return_msg);
        error.name = "ProtocolError";
      } else if (data.mch_id && self.mchId !== data.mch_id) {
        error = new Error();
        error.name = "InvalidMchId";
      } else if (data.sign && self._getSign(data) !== data.sign) {
        error = new Error();
        error.name = "InvalidSignature";
      }
    }

    callback(error, data);
  });
};

/**
 * 使用默认值扩展对象
 * @param  {Object} obj
 * @param  {Array} keysNeedExtend
 * @return {Object} extendedObject
 */
Payment.prototype._extendWithDefault = function(obj, keysNeedExtend) {
  var defaults = {
    mch_id: this.mchId,
    nonce_str: this._generateNonceStr(),
    notify_url: this.notifyUrl,
    version: this.version,
    charset: this.charset,
    sign_type: this.sign_type
  };
  var extendObject = {};
  keysNeedExtend.forEach(function(k) {
    if (defaults[k]) {
      extendObject[k] = defaults[k];
    }
  });
  return _.extend(extendObject, obj);
};

Payment.prototype._getSign = function(pkg, signType) {
  pkg = _.clone(pkg);
  delete pkg.sign;
  signType = signType || "MD5";
  var string1 = this._toQueryString(pkg);
  var stringSignTemp = string1 + "&key=" + this.partnerKey;
  var signValue = signTypes[signType](stringSignTemp).toUpperCase();
  return signValue;
};

Payment.prototype._toQueryString = function(object) {
  return Object.keys(object)
    .filter(function(key) {
      return object[key] !== undefined && object[key] !== "";
    })
    .sort()
    .map(function(key) {
      return key + "=" + object[key];
    })
    .join("&");
};

Payment.prototype._generateTimeStamp = function() {
  return parseInt(+new Date() / 1000, 10) + "";
};

/**
 * [_generateNonceStr description]
 * @param  {[type]} length [description]
 * @return {[type]}        [description]
 */
Payment.prototype._generateNonceStr = function(length) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var maxPos = chars.length;
  var noceStr = "";
  var i;
  for (i = 0; i < (length || 32); i++) {
    noceStr += chars.charAt(Math.floor(Math.random() * maxPos));
  }
  return noceStr;
};

/**
 * Promisify for public functions
 */
if (global.Promise) {
  for (let key in Payment.prototype) {
    let func = Payment.prototype[key];
    let syncFuncs = ["buildXml"];
    if (typeof func == "function" && key.indexOf("_") !== 0 && syncFuncs.indexOf(key) === -1) {
      Payment.prototype[key] = function() {
        let args = Array.prototype.slice.call(arguments);
        let originCallback = args[args.length - 1];
        return new Promise((resolve, reject) => {
          let handleResult = function(err, result) {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          };
          if (typeof originCallback !== "function") {
            args.push(handleResult);
          } else {
            args[args.length - 1] = function(err, result) {
              handleResult(err, result);
              originCallback(err, result);
            };
          }
          func.apply(this, args);
        });
      };
    }
  }
}

exports.Payment = Payment;
