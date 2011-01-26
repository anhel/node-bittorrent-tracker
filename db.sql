CREATE TABLE IF NOT EXISTS `users` (
 `userid` int(11) NOT NULL AUTO_INCREMENT,
 PRIMARY KEY (`userid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 AUTO_INCREMENT=1 ;

CREATE TABLE IF NOT EXISTS `torrents` (
  `tid` int(11) NOT NULL AUTO_INCREMENT,
 `info_hash` varchar(40) NOT NULL,
 `leechers` int(11) NOT NULL DEFAULT '0',
 `seeders` int(11) NOT NULL DEFAULT '0',
 `completed` int(11) NOT NULL DEFAULT '0',
 `downloads` int(11) NOT NULL DEFAULT '0'
 PRIMARY KEY (`tid`),
 KEY `info_hash` (`info_hash`)
) ENGINE=InnoDB  DEFAULT CHARSET=utf8 AUTO_INCREMENT=1 ;